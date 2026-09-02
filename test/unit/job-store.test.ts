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

async function createStore(): Promise<JobStore> {
  const root = await mkdtemp(join(tmpdir(), "rostra-jobs-"));
  roots.push(root);
  return new JobStore(await openStorage(join(root, "rostra.sqlite")), {
    dedupeSuccessMs: 10_000,
    leaseMs: 5_000,
  });
}

const request = startDeliberationInputSchema.parse({
  question: "Choose a durable design",
  working_directory: "/tmp/work",
  protocol: "quick",
  committee: { mode: "explicit" },
  participants: [
    { participant_id: "reviewer_a", cli: "codex", model: "sol" },
    { participant_id: "reviewer_b", cli: "claude", model: "opus" },
  ],
});

describe("durable job store", () => {
  it("deduplicates canonical requests and detects idempotency conflicts", async () => {
    const store = await createStore();
    const first = store.submit(request, { idempotencyKey: "stable-key", nowMs: 100 });
    const same = store.submit({ ...request }, { idempotencyKey: "stable-key", nowMs: 101 });
    expect(same).toMatchObject({ job_id: first.job_id, deduplicated: true });

    expect(() =>
      store.submit(
        { ...request, question: "Different" },
        {
          idempotencyKey: "stable-key",
          nowMs: 102,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));

    const fingerprintDedupe = store.submit(request, { nowMs: 103 });
    expect(fingerprintDedupe.job_id).toBe(first.job_id);
    const forced = store.submit(request, { forceNew: true, nowMs: 104 });
    expect(forced.job_id).not.toBe(first.job_id);
    store.close();
  });

  it("guards transitions with leases and row versions while ordering events", async () => {
    const store = await createStore();
    const submission = store.submit(request, { nowMs: 1_000 });
    const claimed = store.claimNext("build-a", "config-a", 1_001);
    expect(claimed).toMatchObject({
      job_id: submission.job_id,
      status: "dispatching",
      row_version: 1,
    });
    if (claimed === undefined) throw new Error("Expected claimed job");

    const running = store.handshakeWorker(
      claimed.job_id,
      claimed.dispatch_token,
      claimed.row_version,
      1_002,
    );
    expect(running).toMatchObject({ status: "running", row_version: 2 });
    expect(() =>
      store.heartbeat(running.job_id, "wrong-token", running.row_version, 1_003),
    ).toThrowError(expect.objectContaining({ code: "lease_lost" }));
    const heartbeat = store.heartbeat(
      running.job_id,
      running.lease_token,
      running.row_version,
      1_003,
    );
    const cancellation = store.requestCancellation(running.job_id, "stop", 1_004);
    const repeated = store.requestCancellation(running.job_id, "stop", 1_005);
    expect(cancellation.status).toBe("cancelling");
    expect(repeated.row_version).toBe(cancellation.row_version);

    const cancelled = store.transition({
      jobId: running.job_id,
      expectedStatus: "cancelling",
      nextStatus: "cancelled",
      leaseToken: heartbeat.lease_token,
      expectedVersion: cancellation.row_version,
      eventType: "cancelled",
      nowMs: 1_006,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(store.events(running.job_id, 0, 100).map((event) => event.seq)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    store.close();
  });

  it("paginates deterministically and reuses completed attempts", async () => {
    const store = await createStore();
    store.submit({ ...request, question: "one" }, { forceNew: true, nowMs: 100 });
    const second = store.submit({ ...request, question: "two" }, { forceNew: true, nowMs: 101 });
    store.submit({ ...request, question: "three" }, { forceNew: true, nowMs: 102 });
    const page = store.list({ limit: 2 });
    expect(page.jobs.map((job) => job.question)).toEqual(["one", "two"]);
    expect(
      store.list({ limit: 2, cursor: page.next_cursor }).jobs.map((job) => job.question),
    ).toEqual(["three"]);

    const attempt = store.createAttempt({
      jobId: second.job_id,
      stageId: "analysis",
      participantId: "reviewer_a",
      attemptKind: "stage",
      ordinal: 0,
      requestDigest: "abc",
      executionIsolation: "builtin_confined",
      nowMs: 103,
    });
    store.finishAttempt(
      attempt.attempt_id,
      "succeeded",
      { responseId: "response-a", responseDigest: "def" },
      104,
    );
    expect(
      store.createAttempt({
        jobId: second.job_id,
        stageId: "analysis",
        participantId: "reviewer_a",
        attemptKind: "stage",
        ordinal: 0,
        requestDigest: "abc",
        executionIsolation: "builtin_confined",
        nowMs: 105,
      }),
    ).toMatchObject({ attempt_id: attempt.attempt_id, status: "succeeded" });
    const processId = store.registerProcess({
      jobId: second.job_id,
      attemptId: attempt.attempt_id,
      pid: 123,
      pidStartedAtMs: 106,
      role: "adapter",
      nowMs: 106,
    });
    store.markProcessExited(processId, false, 107);
    expect(
      store.recordQuality({
        adapter: "codex",
        model: "sol",
        domain: "general",
        valid_attempt: true,
        valid_ballot: true,
        latencyMs: 25,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
        nowMs: 108,
      }),
    ).toMatchObject({ attempts: 1, valid_attempts: 1, latency_samples_ms: [25] });
    store.transition({
      jobId: second.job_id,
      expectedStatus: "queued",
      nextStatus: "cancelled",
      expectedVersion: 0,
      eventType: "cancelled",
      nowMs: 200,
    });
    expect(store.purgeTerminalJobs(1_000, 100)).toBe(1);
    store.close();
  });
});
