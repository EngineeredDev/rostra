import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decisionPacketSchema } from "../../src/contracts/results.js";
import {
  queryDecisionsInputSchema,
  startDeliberationInputSchema,
  type StartDeliberationInput,
} from "../../src/contracts/tools.js";
import { DecisionRepository } from "../../src/decisions/repository.js";
import { deriveWorkspaceIdentity } from "../../src/decisions/workspace.js";
import { JobStore } from "../../src/jobs/store.js";
import { openStorage } from "../../src/storage/database.js";

const roots: string[] = [];
const participants = [
  { participant_id: "a", cli: "fake", model: "a" },
  { participant_id: "b", cli: "fake", model: "b" },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(
  root: string,
  question: string,
  continuationId?: string,
): StartDeliberationInput {
  return startDeliberationInputSchema.parse({
    question,
    working_directory: root,
    protocol: "quick",
    ...(continuationId === undefined ? {} : { continuation_id: continuationId }),
    committee: { mode: "explicit" },
    participants,
  });
}

function publish(input: {
  store: JobStore;
  request: StartDeliberationInput;
  workspaceId: string;
  canonicalRoot: string;
  nowMs: number;
}): string {
  input.store.submit(input.request, { forceNew: true, nowMs: input.nowMs });
  const claimed = input.store.claimNext("build", "config", input.nowMs + 1);
  if (claimed === undefined) throw new Error("Expected a queued job");
  const running = input.store.handshakeWorker(
    claimed.job_id,
    claimed.dispatch_token,
    claimed.row_version,
    input.nowMs + 2,
  );
  if (running.lease_token === undefined) throw new Error("Expected a lease");
  const decisionId = randomUUID();
  const packet = decisionPacketSchema.parse({
    decision_id: decisionId,
    job_id: running.job_id,
    question: input.request.question,
    protocol: input.request.protocol,
    participants,
    committee_selection: [],
    committee_limited: false,
    ballot: {
      outcome: "no_ballots",
      consensus_reached: false,
      participant_count: participants.length,
      quorum_required: 2,
      valid_ballots: 0,
      abstentions: participants.length,
      final_tally: {},
      minority_reports: [],
      ballot_history: [],
    },
    convergence: {
      within_model_stability: 0,
      cross_model_agreement: 0,
      vote_stability: 0,
      disagreement_streak: 0,
      impasse: false,
      progress: {
        checks: 0,
        comparisons: 0,
        quorum_required: 2,
        valid_votes: 0,
        options: [],
      },
    },
    claims: [],
    evidence: [],
    predictions: [],
    agreements: [],
    assumptions: [],
    unresolved_claims: [],
    failed_participants: [],
    experiment_proposals: [],
    execution_isolation: "builtin_confined",
    created_at_ms: input.nowMs + 3,
    review_due_at_ms: input.nowMs + 100_000,
  });
  input.store.commitDecisionResult({
    jobId: running.job_id,
    expectedVersion: running.row_version,
    leaseToken: running.lease_token,
    workspaceId: input.workspaceId,
    canonicalRoot: input.canonicalRoot,
    requestFingerprint: running.request_fingerprint,
    packet,
    summary: input.request.question,
    resultStatus: "partial",
    resultJson: { status: "partial", decision_id: decisionId },
    transcriptPath: join(input.canonicalRoot, `${decisionId}.md`),
    nowMs: input.nowMs + 4,
  });
  return decisionId;
}

describe("decision continuation chains", () => {
  it("creates one workspace thread and queries the complete chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "rostra-continuation-"));
    roots.push(root);
    const db = await openStorage(join(root, "rostra.sqlite"));
    const store = new JobStore(db, { dedupeSuccessMs: 1_000, leaseMs: 1_000 });
    const workspace = await deriveWorkspaceIdentity(root);
    const first = publish({
      store,
      request: request(root, "first decision"),
      workspaceId: workspace.id,
      canonicalRoot: workspace.canonicalRoot,
      nowMs: 100,
    });
    const second = publish({
      store,
      request: request(root, "second decision", first),
      workspaceId: workspace.id,
      canonicalRoot: workspace.canonicalRoot,
      nowMs: 200,
    });
    const third = publish({
      store,
      request: request(root, "third decision", second),
      workspaceId: workspace.id,
      canonicalRoot: workspace.canonicalRoot,
      nowMs: 300,
    });

    const threadRows = db.prepare<[], { id: string; thread_id: string | null }>(`
      SELECT id, thread_id FROM decisions ORDER BY created_at_ms, id
    `).all();
    expect(threadRows).toEqual([
      { id: first, thread_id: first },
      { id: second, thread_id: first },
      { id: third, thread_id: first },
    ]);
    expect(db.prepare<[], { count: number }>("SELECT count(*) AS count FROM threads").get())
      .toEqual({ count: 1 });

    const page = await new DecisionRepository(db).query(queryDecisionsInputSchema.parse({
      working_directory: root,
      continuation_id: second,
      include_stale: true,
      limit: 10,
    }));
    expect(page.decisions.map((decision) => decision.id)).toEqual([first, second, third]);
    store.close();
  });
});
