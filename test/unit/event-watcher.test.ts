import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDeliberationInputSchema, type JobStatus } from "../../src/contracts/tools.js";
import { JobEventWatcher, type CounselNotifier } from "../../src/jobs/event-watcher.js";
import { JobStore } from "../../src/jobs/store.js";
import { openStorage } from "../../src/storage/database.js";

const roots: string[] = [];
const stores: JobStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const request = startDeliberationInputSchema.parse({
  question: "Watch this job",
  working_directory: "/tmp/work",
  protocol: "quick",
  committee: { mode: "explicit" },
  participants: [
    { participant_id: "reviewer_a", cli: "codex", model: "sol" },
    { participant_id: "reviewer_b", cli: "claude", model: "opus" },
  ],
});

async function createStore(): Promise<JobStore> {
  const root = await mkdtemp(join(tmpdir(), "ai-counsel-watcher-"));
  roots.push(root);
  const store = new JobStore(await openStorage(join(root, "ai-counsel.sqlite")), {
    dedupeSuccessMs: 10_000,
    leaseMs: 5_000,
  });
  stores.push(store);
  return store;
}

function recorder(): { notifier: CounselNotifier; seen: string[] } {
  const seen: string[] = [];
  return { notifier: { resourceUpdated: (uri) => seen.push(uri) }, seen };
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

function watcherFor(store: JobStore, notifier: CounselNotifier): JobEventWatcher {
  return new JobEventWatcher({
    store,
    notifier,
    intervalMs: 1_000,
    urisForJob: (jobId) => [`counsel://deliberations/${jobId}`, `counsel://deliberations/${jobId}/events`],
  });
}

describe("job event watcher", () => {
  it("publishes both URIs once per changed job and advances its watermark", async () => {
    const store = await createStore();
    const { notifier, seen } = recorder();
    const watcher = watcherFor(store, notifier);
    const submission = store.submit(request);

    watcher.tick();
    expect(seen).toEqual([
      `counsel://deliberations/${submission.job_id}`,
      `counsel://deliberations/${submission.job_id}/events`,
    ]);

    seen.length = 0;
    watcher.tick();
    expect(seen).toEqual([]);

    store.claimNext("build-a", "config-a");
    watcher.tick();
    expect(seen).toHaveLength(2);
  });

  it("drains a job that reached a terminal state and then forgets it", async () => {
    const store = await createStore();
    const { notifier, seen } = recorder();
    const watcher = watcherFor(store, notifier);
    const submission = store.submit(request);
    store.claimNext("build-a", "config-a");
    advance(store, submission.job_id, "running", "worker_started");
    watcher.tick();

    seen.length = 0;
    advance(store, submission.job_id, "succeeded", "job_succeeded");
    watcher.tick();
    expect(seen).toHaveLength(2);

    seen.length = 0;
    watcher.tick();
    expect(seen).toEqual([]);
  });

  it("ignores jobs that never gained events since the last pass", async () => {
    const store = await createStore();
    const { notifier, seen } = recorder();
    const watcher = watcherFor(store, notifier);
    store.submit(request);
    watcher.tick();
    seen.length = 0;

    watcher.tick();
    watcher.tick();
    expect(seen).toEqual([]);
  });
});
