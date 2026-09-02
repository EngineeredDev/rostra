import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDeliberationInputSchema } from "../../src/contracts/tools.js";
import { DecisionPublisher } from "../../src/decisions/publication.js";
import { JobStore } from "../../src/jobs/store.js";
import { openStorage } from "../../src/storage/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable decision origins", () => {
  it("survives operational retention and makes publication idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "rostra-origin-"));
    roots.push(root);
    const db = await openStorage(join(root, "rostra.sqlite"));
    const store = new JobStore(db, { dedupeSuccessMs: 1_000, leaseMs: 1_000 });
    const request = startDeliberationInputSchema.parse({
      question: "retain this decision",
      working_directory: root,
      protocol: "quick",
      committee: { mode: "explicit" },
      participants: [
        { participant_id: "a", cli: "fake", model: "a" },
        { participant_id: "b", cli: "fake", model: "b" },
      ],
    });
    const submitted = store.submit(request, { nowMs: 10 });
    const dispatching = store.claimNext("build", "config", 11);
    if (dispatching === undefined) throw new Error("Expected dispatch");
    const running = store.handshakeWorker(
      dispatching.job_id,
      dispatching.dispatch_token,
      dispatching.row_version,
      12,
    );
    store.transition({
      jobId: running.job_id,
      expectedStatus: "running",
      nextStatus: "succeeded",
      expectedVersion: running.row_version,
      leaseToken: running.lease_token,
      eventType: "completed",
      nowMs: 20,
    });

    const publisher = new DecisionPublisher(db);
    const decisionId = randomUUID();
    const publication = publisher.publish({
      jobId: submitted.job_id,
      decisionId,
      workspaceId: "workspace-a",
      canonicalRoot: root,
      requestFingerprint: store.get(submitted.job_id).request_fingerprint,
      question: request.question,
      protocol: request.protocol,
      resultStatus: "partial",
      canonicalResult: { status: "partial", value: 1 },
      summary: "partial result",
      executionIsolation: "builtin_confined",
      reviewDueAtMs: 1_000,
      nowMs: 20,
    });
    expect(publication).toEqual({ decisionId, created: true });
    const childId = randomUUID();
    expect(
      publisher.publish({
        jobId: randomUUID(),
        decisionId: childId,
        workspaceId: "workspace-a",
        canonicalRoot: root,
        requestFingerprint: "child",
        continuationId: decisionId,
        question: "continue this decision",
        protocol: request.protocol,
        resultStatus: "partial",
        canonicalResult: { status: "partial", value: 2 },
        summary: "child result",
        executionIsolation: "builtin_confined",
        reviewDueAtMs: 1_500,
        nowMs: 30,
      }),
    ).toEqual({ decisionId: childId, created: true });
    expect(
      db
        .prepare<[string, string], { thread_id: string | null }>(
          "SELECT thread_id FROM decisions WHERE id IN (?, ?) ORDER BY id",
        )
        .all(decisionId, childId)
        .map((row) => row.thread_id),
    ).toEqual([decisionId, decisionId]);
    expect(store.purgeTerminalJobs(1_000, 100)).toBe(1);
    expect(
      publisher.publish({
        jobId: submitted.job_id,
        decisionId: randomUUID(),
        workspaceId: "workspace-a",
        canonicalRoot: root,
        requestFingerprint: "ignored-on-retry",
        question: request.question,
        protocol: request.protocol,
        resultStatus: "partial",
        canonicalResult: { status: "partial", value: 2 },
        summary: "retry",
        executionIsolation: "builtin_confined",
        reviewDueAtMs: 2_000,
        nowMs: 1_000,
      }),
    ).toEqual({ decisionId, created: false });
    expect(publisher.getDecision(decisionId)?.summary).toBe("partial result");
    store.close();
  });
});
