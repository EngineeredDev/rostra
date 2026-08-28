import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { startDeliberationInputSchema, type JobStatus } from "../../src/contracts/tools.js";
import { DecisionCiReviewer } from "../../src/decision-ci/review.js";
import { DecisionRepository } from "../../src/decisions/repository.js";
import { JobStore } from "../../src/jobs/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { openStorage } from "../../src/storage/database.js";

const roots: string[] = [];
const stores: JobStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const config = configSchema.parse({
  version: 2,
  adapters: {},
  model_registry: { models: [] },
  defaults: { protocol: "quick" },
  protocols: {},
  similarity: { provider: "local_minilm" },
  execution: { allow_host_tools: false },
  jobs: { poll_interval_ms: 10, wait_min_seconds: 1, wait_max_seconds: 5 },
  storage: {},
  decision_graph: {},
});

const request = startDeliberationInputSchema.parse({
  question: "Should progress notifications be emitted?",
  working_directory: "/tmp/work",
  protocol: "quick",
  committee: { mode: "explicit" },
  participants: [
    { participant_id: "reviewer_a", cli: "codex", model: "sol" },
    { participant_id: "reviewer_b", cli: "claude", model: "opus" },
  ],
});

async function harness(): Promise<{ client: Client; store: JobStore }> {
  const root = await mkdtemp(join(tmpdir(), "ai-counsel-progress-"));
  roots.push(root);
  const db = await openStorage(join(root, "ai-counsel.sqlite"));
  const store = new JobStore(db, { dedupeSuccessMs: 1_000, leaseMs: 5_000 });
  stores.push(store);
  const server = createMcpServer({
    config,
    store,
    decisions: new DecisionRepository(db),
    reviewer: new DecisionCiReviewer(db),
    ensureSupervisor: () => Promise.resolve(),
  });
  const client = new Client({ name: "progress-integration", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, store };
}

function advance(store: JobStore, jobId: string, nextStatus: JobStatus, eventType: string): void {
  const job = store.get(jobId);
  store.transition({
    jobId,
    expectedStatus: job.status,
    nextStatus,
    expectedVersion: job.row_version,
    eventType,
  });
}

describe("progress notifications", () => {
  it("streams monotonic progress while get_deliberation waits for a terminal job", async () => {
    const { client, store } = await harness();
    const submission = store.submit(request);
    store.claimNext("build-a", "config-a");
    const observed: number[] = [];

    const call = client.callTool(
      {
        name: "get_deliberation",
        arguments: { job_id: submission.job_id, wait_for_terminal: true },
      },
      {
        onprogress: (progress) => {
          observed.push(progress.progress);
        },
      },
    );
    setTimeout(() => { advance(store, submission.job_id, "running", "worker_started"); }, 30);
    setTimeout(() => { advance(store, submission.job_id, "succeeded", "job_succeeded"); }, 90);
    const result = await call;

    expect(result.structuredContent).toMatchObject({
      job_id: submission.job_id,
      status: "succeeded",
    });
    expect(observed.length).toBeGreaterThan(0);
    expect(observed).toEqual([...observed].sort((left, right) => left - right));
    expect(new Set(observed).size).toBe(observed.length);
  });

  it("emits nothing when the client sends no progress token", async () => {
    const { client, store } = await harness();
    const submission = store.submit(request);
    store.claimNext("build-a", "config-a");
    const notifications: unknown[] = [];
    client.setNotificationHandler("notifications/progress", (notification) => {
      notifications.push(notification);
    });

    const call = client.callTool({
      name: "get_deliberation",
      arguments: { job_id: submission.job_id, wait_for_terminal: true },
    });
    setTimeout(() => { advance(store, submission.job_id, "running", "worker_started"); }, 30);
    setTimeout(() => { advance(store, submission.job_id, "succeeded", "job_succeeded"); }, 90);
    await call;

    expect(notifications).toEqual([]);
  });

  it("reports newly appended events while tail_deliberation waits for a change", async () => {
    const { client, store } = await harness();
    const submission = store.submit(request);
    const claimed = store.claimNext("build-a", "config-a");
    const afterSeq = store.events(submission.job_id).at(-1)?.seq ?? 0;
    expect(claimed?.job_id).toBe(submission.job_id);
    const observed: number[] = [];

    const call = client.callTool(
      {
        name: "tail_deliberation",
        arguments: { job_id: submission.job_id, after_seq: afterSeq, wait_for_change: true },
      },
      {
        onprogress: (progress) => {
          observed.push(progress.progress);
        },
      },
    );
    setTimeout(() => { advance(store, submission.job_id, "running", "worker_started"); }, 30);
    const result = await call;

    expect(result.structuredContent).toMatchObject({
      job_id: submission.job_id,
      timed_out: false,
    });
    expect(observed).toEqual([afterSeq + 1]);
  });
});
