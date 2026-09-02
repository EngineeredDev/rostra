import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDeliberationInputSchema } from "../../src/contracts/tools.js";
import { JobStore } from "../../src/jobs/store.js";
import { openStorage } from "../../src/storage/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const request = startDeliberationInputSchema.parse({
  question: "recover work",
  working_directory: "/tmp",
  protocol: "quick",
  committee: { mode: "explicit" },
  participants: [
    { participant_id: "a", cli: "fake", model: "a" },
    { participant_id: "b", cli: "fake", model: "b" },
  ],
});

describe("stale job recovery", () => {
  it("requeues stale dispatch and checkpointed work without replaying attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "rostra-recovery-"));
    roots.push(root);
    const store = new JobStore(await openStorage(join(root, "rostra.sqlite")), {
      dedupeSuccessMs: 1_000,
      leaseMs: 100,
    });
    const dispatchJob = store.submit(request, { forceNew: true, nowMs: 1 });
    store.claimNext("build", "config", 2);
    expect(store.recoverStale(200)).toEqual([
      { jobId: dispatchJob.job_id, action: "requeued_dispatch" },
    ]);
    expect(store.get(dispatchJob.job_id).status).toBe("queued");

    const runningJob = store.submit(
      { ...request, question: "checkpoint" },
      {
        forceNew: true,
        nowMs: 201,
      },
    );
    const claimed = store.claimNext("build", "config", 202);
    if (claimed === undefined || claimed.job_id !== dispatchJob.job_id) {
      throw new Error("Expected the requeued dispatch first");
    }
    store.requestCancellation(dispatchJob.job_id, "clear", 203);
    const claimedRunning = store.claimNext("build", "config", 204);
    if (claimedRunning === undefined) throw new Error("Expected running claim");
    store.handshakeWorker(
      claimedRunning.job_id,
      claimedRunning.dispatch_token,
      claimedRunning.row_version,
      205,
    );
    store.saveCheckpoint(runningJob.job_id, "context_loaded", { next_stage: 0 }, 206);
    expect(store.recoverStale(400)).toEqual([
      { jobId: runningJob.job_id, action: "requeued_checkpoint" },
    ]);
    expect(store.get(runningJob.job_id).status).toBe("queued");
    store.close();
  });

  it("marks external attempts uncertain and requires an explicit retry ordinal", async () => {
    const root = await mkdtemp(join(tmpdir(), "rostra-uncertain-"));
    roots.push(root);
    const store = new JobStore(await openStorage(join(root, "rostra.sqlite")), {
      dedupeSuccessMs: 1_000,
      leaseMs: 100,
    });
    const submitted = store.submit(request, { forceNew: true, nowMs: 1 });
    const claimed = store.claimNext("build", "config", 2);
    if (claimed === undefined) throw new Error("Expected claim");
    store.handshakeWorker(claimed.job_id, claimed.dispatch_token, claimed.row_version, 3);
    store.saveCheckpoint(submitted.job_id, "context_loaded", { next_stage: 0 }, 4);
    const attempt = store.createAttempt({
      jobId: submitted.job_id,
      stageId: "analysis",
      participantId: "a",
      attemptKind: "stage",
      ordinal: 0,
      requestDigest: "digest",
      executionIsolation: "host_unrestricted",
      nowMs: 5,
    });
    store.markAttemptStarted(attempt.attempt_id, true, 6);
    expect(store.recoverStale(200)).toEqual([
      { jobId: submitted.job_id, action: "recovery_required" },
    ]);
    expect(store.get(submitted.job_id).status).toBe("recovery_required");
    expect(store.attempts(submitted.job_id)[0]?.status).toBe("uncertain");

    expect(store.resumeRecovery(submitted.job_id, "retry", 201).status).toBe("queued");
    const retry = store.createAttempt({
      jobId: submitted.job_id,
      stageId: "analysis",
      participantId: "a",
      attemptKind: "stage",
      ordinal: 0,
      requestDigest: "digest",
      executionIsolation: "host_unrestricted",
      nowMs: 202,
    });
    expect(retry.ordinal).toBe(1);
    expect(retry.status).toBe("pending");
    store.close();
  });
});
