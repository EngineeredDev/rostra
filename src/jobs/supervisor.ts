import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/schema.js";
import { AppError } from "../errors.js";
import {
  SystemProcessIdentityProvider,
  currentProcessIdentity,
  type ProcessIdentityProvider,
} from "../process/identity.js";
import type { StorageDatabase } from "../storage/database.js";
import { openStorage } from "../storage/database.js";
import { reconcileMissingTranscripts } from "../transcript/reconcile.js";
import { JobStore } from "./store.js";

interface SupervisorRow {
  singleton: 1;
  owner_token: string;
  pid: number;
  pid_started_at_ms: number;
  build_id: string;
  config_digest: string;
  status: "starting" | "ready" | "draining" | "stopped";
  heartbeat_at_ms: number;
  updated_at_ms: number;
}

export interface EnsureSupervisorOptions {
  db: StorageDatabase;
  databasePath: string;
  configPath: string;
  config: Config;
  buildId: string;
  configDigest: string;
  supervisorEntrypoint?: string;
  workerEntrypoint?: string;
  identityProvider?: ProcessIdentityProvider;
  readyTimeoutMs?: number;
}

export interface RunSupervisorOptions {
  databasePath: string;
  configPath: string;
  config: Config;
  ownerToken: string;
  buildId: string;
  configDigest: string;
  workerEntrypoint: string;
}

function supervisorRow(db: StorageDatabase): SupervisorRow | undefined {
  return db.prepare<[], SupervisorRow>("SELECT * FROM supervisor_state WHERE singleton = 1").get();
}

function activeExecutorJobs(db: StorageDatabase, buildId: string, configDigest: string): number {
  const row = db.prepare<[string, string], { count: number }>(`
    SELECT COUNT(*) AS count FROM jobs
    WHERE status IN ('dispatching', 'running', 'cancelling')
      AND build_id = ? AND config_digest = ?
  `).get(buildId, configDigest);
  return row?.count ?? 0;
}

async function verifiedSupervisor(
  row: SupervisorRow,
  provider: ProcessIdentityProvider,
): Promise<boolean> {
  if (row.pid <= 0) {
    return false;
  }
  const identity = await provider.identify(row.pid, process.platform === "win32" ? undefined : row.pid);
  return identity !== undefined && Math.abs(identity.startedAtMs - row.pid_started_at_ms) <= 1_500;
}

export async function ensureSupervisor(options: EnsureSupervisorOptions): Promise<void> {
  const provider = options.identityProvider ?? new SystemProcessIdentityProvider();
  const timeoutMs = options.readyTimeoutMs ?? 10_000;
  let existing = supervisorRow(options.db);
  if (
    existing?.status === "ready" &&
    existing.build_id === options.buildId &&
    existing.config_digest === options.configDigest &&
    (await verifiedSupervisor(existing, provider))
  ) {
    return;
  }

  if (existing !== undefined) {
    const matching =
      existing.build_id === options.buildId && existing.config_digest === options.configDigest;
    if (!matching && activeExecutorJobs(options.db, existing.build_id, existing.config_digest) > 0) {
      throw new AppError(
        "executor_version_mismatch",
        "The previous executor must drain active work before new dispatch",
      );
    }
    if (existing.pid > 0 && (await verifiedSupervisor(existing, provider))) {
      await provider.terminate(
        {
          pid: existing.pid,
          startedAtMs: existing.pid_started_at_ms,
          ...(process.platform === "win32" ? {} : { processGroupId: existing.pid }),
        },
        "SIGTERM",
      );
    }
  }

  const ownerToken = randomUUID();
  const nowMs = Date.now();
  options.db.transaction(() => {
    options.db.prepare("DELETE FROM supervisor_state WHERE singleton = 1").run();
    options.db.prepare(`
      INSERT INTO supervisor_state(
        singleton, owner_token, pid, pid_started_at_ms, build_id, config_digest,
        status, heartbeat_at_ms, updated_at_ms
      ) VALUES (1, ?, 0, 0, ?, ?, 'starting', ?, ?)
    `).run(ownerToken, options.buildId, options.configDigest, nowMs, nowMs);
  }).immediate();

  const supervisorEntrypoint = options.supervisorEntrypoint
    ?? fileURLToPath(new URL("./supervisor-main.js", import.meta.url));
  const workerEntrypoint = options.workerEntrypoint
    ?? fileURLToPath(new URL("./worker-main.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      supervisorEntrypoint,
      "--database", options.databasePath,
      "--config", options.configPath,
      "--owner-token", ownerToken,
      "--build-id", options.buildId,
      "--config-digest", options.configDigest,
      "--worker-entrypoint", workerEntrypoint,
    ],
    { detached: true, shell: false, stdio: "ignore", windowsHide: true },
  );
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    existing = supervisorRow(options.db);
    if (
      existing?.owner_token === ownerToken &&
      existing.status === "ready" &&
      existing.build_id === options.buildId &&
      existing.config_digest === options.configDigest
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  options.db.prepare("DELETE FROM supervisor_state WHERE singleton = 1 AND owner_token = ?").run(ownerToken);
  throw new AppError("supervisor_start_failed", "Detached supervisor did not become ready");
}

export async function runSupervisor(options: RunSupervisorOptions): Promise<void> {
  const db = await openStorage(options.databasePath, {
    busyTimeoutMs: options.config.storage.busy_timeout_ms,
  });
  const store = new JobStore(db, {
    dedupeSuccessMs: options.config.jobs.dedupe_success_ms,
    leaseMs: options.config.jobs.lease_ms,
  });
  const identity = currentProcessIdentity();
  const nowMs = Date.now();
  const registration = db.prepare(`
    UPDATE supervisor_state SET
      pid = ?, pid_started_at_ms = ?, status = 'ready', heartbeat_at_ms = ?, updated_at_ms = ?
    WHERE singleton = 1 AND owner_token = ? AND build_id = ? AND config_digest = ?
  `).run(
    identity.pid,
    identity.startedAtMs,
    nowMs,
    nowMs,
    options.ownerToken,
    options.buildId,
    options.configDigest,
  );
  if (registration.changes !== 1) {
    store.close();
    throw new AppError("supervisor_fenced", "Supervisor ownership was rejected");
  }

  let stopping = false;
  const requestStop = (): void => {
    stopping = true;
  };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);

  try {
    while (!stopping) {
      const heartbeatAt = Date.now();
      const heartbeat = db.prepare(`
        UPDATE supervisor_state SET heartbeat_at_ms = ?, updated_at_ms = ?
        WHERE singleton = 1 AND owner_token = ? AND status = 'ready'
      `).run(heartbeatAt, heartbeatAt, options.ownerToken);
      if (heartbeat.changes !== 1) {
        throw new AppError("supervisor_fenced", "Supervisor ownership was lost");
      }

      store.recoverStale();
      await reconcileMissingTranscripts(db);
      let active = db.prepare<[], { count: number }>(`
        SELECT COUNT(*) AS count FROM jobs WHERE status IN ('dispatching', 'running', 'cancelling')
      `).get()?.count ?? 0;
      while (!stopping && active < options.config.jobs.max_concurrency) {
        const claimed = store.claimNext(options.buildId, options.configDigest);
        if (claimed === undefined) {
          break;
        }
        if (claimed.dispatch_token === undefined) {
          throw new AppError("dispatch_rejected", `Missing dispatch token for ${claimed.job_id}`);
        }
        const worker = spawn(
          process.execPath,
          [
            options.workerEntrypoint,
            "--database", options.databasePath,
            "--config", options.configPath,
            "--job-id", claimed.job_id,
            "--dispatch-token", claimed.dispatch_token,
            "--expected-version", String(claimed.row_version),
          ],
          { detached: true, shell: false, stdio: "ignore", windowsHide: true },
        );
        worker.unref();
        active += 1;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, options.config.jobs.poll_interval_ms),
      );
    }
  } finally {
    const stoppedAt = Date.now();
    db.prepare(`
      UPDATE supervisor_state SET status = 'draining', heartbeat_at_ms = ?, updated_at_ms = ?
      WHERE singleton = 1 AND owner_token = ?
    `).run(stoppedAt, stoppedAt, options.ownerToken);
    store.close();
  }
}
