import { rename, rm } from "node:fs/promises";
import type { Config } from "../config/schema.js";
import type { DecisionPacket } from "../contracts/results.js";
import type { JsonValue } from "../utils/canonical-json.js";
import { AppError, errorMessage } from "../errors.js";
import { currentProcessIdentity } from "../process/identity.js";
import { openStorage } from "../storage/database.js";
import type { JobSnapshot } from "./schema.js";
import { RunContext } from "./run-context.js";
import { JobStore } from "./store.js";

export interface WorkerExecutionResult {
  status: "complete" | "partial";
  result: JsonValue;
  decisionId?: string;
  transcriptPath?: string;
  publication?: {
    workspaceId: string;
    canonicalRoot: string;
    requestFingerprint: string;
    packet: DecisionPacket;
    summary: string;
    temporaryTranscriptPath: string;
    transcriptPath: string;
  };
}

export interface StageRunner {
  execute(job: JobSnapshot, context: RunContext): Promise<WorkerExecutionResult>;
}

export interface WorkerOptions {
  databasePath: string;
  config: Config;
  jobId: string;
  dispatchToken: string;
  expectedVersion: number;
  runner: StageRunner;
}

export async function runWorker(options: WorkerOptions): Promise<JobSnapshot | undefined> {
  const db = await openStorage(options.databasePath, {
    busyTimeoutMs: options.config.storage.busy_timeout_ms,
  });
  const store = new JobStore(db, {
    dedupeSuccessMs: options.config.jobs.dedupe_success_ms,
    leaseMs: options.config.jobs.lease_ms,
  });
  const context = new RunContext(options.jobId);
  const identity = currentProcessIdentity();
  const processId = store.registerProcess({
    jobId: options.jobId,
    pid: identity.pid,
    pidStartedAtMs: identity.startedAtMs,
    ...(identity.processGroupId === undefined ? {} : { processGroupId: identity.processGroupId }),
    role: "worker",
  });
  let heartbeat: NodeJS.Timeout | undefined;
  let cleanupUncertain = false;
  let running: JobSnapshot | undefined;

  try {
    running = store.handshakeWorker(
      options.jobId,
      options.dispatchToken,
      options.expectedVersion,
    );
    heartbeat = setInterval(() => {
      try {
        const current = store.get(options.jobId);
        if (current.status === "cancelling") {
          context.cancel(current.cancellation_reason ?? "Cancellation requested");
          return;
        }
        if (current.status === "running") {
          running = store.heartbeat(
            current.job_id,
            current.lease_token,
            current.row_version,
          );
        }
      } catch {
        context.cancel("Worker lease was lost");
      }
    }, options.config.jobs.heartbeat_ms);
    heartbeat.unref();

    const execution = await options.runner.execute(running, context);
    await context.cleanup();
    let current = store.get(options.jobId);
    if (context.signal.aborted && current.status === "running") {
      current = store.requestCancellation(current.job_id, "Worker execution aborted");
    }
    if (current.status === "cancelling") {
      return store.transition({
        jobId: current.job_id,
        expectedStatus: current.status,
        nextStatus: "cancelled",
        expectedVersion: current.row_version,
        leaseToken: current.lease_token,
        eventType: "cancelled",
      });
    }
    if (current.status !== "running") {
      throw new AppError("lease_lost", `Worker no longer owns ${current.job_id}`);
    }
    if (execution.publication !== undefined) {
      if (current.lease_token === undefined) {
        throw new AppError("lease_lost", `Missing publication lease for ${current.job_id}`);
      }
      const publication = execution.publication;
      const committed = store.commitDecisionResult({
        jobId: current.job_id,
        expectedVersion: current.row_version,
        leaseToken: current.lease_token,
        workspaceId: publication.workspaceId,
        canonicalRoot: publication.canonicalRoot,
        requestFingerprint: publication.requestFingerprint,
        packet: publication.packet,
        summary: publication.summary,
        resultStatus: execution.status,
        resultJson: execution.result,
        transcriptPath: publication.transcriptPath,
      });
      try {
        await rename(publication.temporaryTranscriptPath, publication.transcriptPath);
      } catch {
        await rm(publication.temporaryTranscriptPath, { force: true });
      }
      return committed;
    }
    return store.transition({
      jobId: current.job_id,
      expectedStatus: "running",
      nextStatus: "succeeded",
      expectedVersion: current.row_version,
      leaseToken: current.lease_token,
      eventType: "completed",
      eventPayload: { result_status: execution.status },
      updates: {
        resultStatus: execution.status,
        resultJson: execution.result,
        ...(execution.decisionId === undefined ? {} : { decisionId: execution.decisionId }),
        ...(execution.transcriptPath === undefined
          ? {}
          : { transcriptPath: execution.transcriptPath }),
      },
    });
  } catch (error) {
    try {
      await context.cleanup();
    } catch {
      cleanupUncertain = true;
    }
    let current: JobSnapshot;
    try {
      current = store.get(options.jobId);
    } catch {
      return undefined;
    }
    if (current.status === "cancelling") {
      return store.transition({
        jobId: current.job_id,
        expectedStatus: "cancelling",
        nextStatus: "cancelled",
        expectedVersion: current.row_version,
        leaseToken: current.lease_token,
        eventType: "cancelled",
        eventPayload: cleanupUncertain ? { cleanup_status: "uncertain" } : {},
      });
    }
    if (current.status === "running") {
      return store.transition({
        jobId: current.job_id,
        expectedStatus: "running",
        nextStatus: "failed",
        expectedVersion: current.row_version,
        leaseToken: current.lease_token,
        eventType: "failed",
        eventPayload: {
          error_type: error instanceof AppError ? error.code : "worker_failed",
          message: errorMessage(error),
          cleanup_status: cleanupUncertain ? "uncertain" : "confirmed",
        },
      });
    }
    return current;
  } finally {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
    }
    try {
      store.markProcessExited(processId, cleanupUncertain);
    } catch {
      // The process row remains running for supervisor reconciliation.
    }
    store.close();
  }
}
