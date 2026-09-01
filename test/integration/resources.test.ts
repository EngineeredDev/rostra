import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  type McpServer,
  type ReadResourceResult,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { startDeliberationInputSchema, type JobStatus } from "../../src/contracts/tools.js";
import { DecisionCiReviewer } from "../../src/decision-ci/review.js";
import { DecisionRepository } from "../../src/decisions/repository.js";
import { JobEventWatcher } from "../../src/jobs/event-watcher.js";
import { JobStore } from "../../src/jobs/store.js";
import { deliberationUris } from "../../src/mcp/projection.js";
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
  jobs: { poll_interval_ms: 10 },
  storage: {},
  decision_graph: {},
});

const request = startDeliberationInputSchema.parse({
  question: "Expose deliberations as resources?",
  working_directory: "/tmp/work",
  protocol: "quick",
  committee: { mode: "explicit" },
  participants: [
    { participant_id: "reviewer_a", cli: "codex", model: "sol" },
    { participant_id: "reviewer_b", cli: "claude", model: "opus" },
  ],
});

async function harness(): Promise<{ client: Client; server: McpServer; store: JobStore }> {
  const root = await mkdtemp(join(tmpdir(), "rostra-resources-"));
  roots.push(root);
  const db = await openStorage(join(root, "rostra.sqlite"));
  const store = new JobStore(db, { dedupeSuccessMs: 1_000, leaseMs: 5_000 });
  stores.push(store);
  const server = createMcpServer({
    config,
    store,
    decisions: new DecisionRepository(db),
    reviewer: new DecisionCiReviewer(db),
    sessionModels: new Map<string, string>(),
    ensureSupervisor: () => Promise.resolve(),
  });
  const client = new Client({ name: "resources-integration", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, store };
}

function readJson(contents: ReadResourceResult["contents"]): unknown {
  const first = contents[0];
  return JSON.parse(first !== undefined && "text" in first ? first.text : "null");
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

describe("deliberation resources", () => {
  it("advertises the resource subscribe capability", async () => {
    const { client } = await harness();
    expect(client.getServerCapabilities()?.resources).toMatchObject({
      subscribe: true,
      listChanged: true,
    });
  });

  it("lists both templates rather than an unbounded resource set", async () => {
    const { client } = await harness();
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
      "rostra://deliberations/{job_id}",
      "rostra://deliberations/{job_id}/events",
    ]);
    await expect(client.listResources()).resolves.toMatchObject({ resources: [] });
  });

  it("returns the same payloads as get_deliberation and tail_deliberation", async () => {
    const { client, store } = await harness();
    const submission = store.submit(request);
    store.claimNext("build-a", "config-a");
    const [jobUri, eventsUri] = deliberationUris(submission.job_id);

    const jobResource = await client.readResource({ uri: jobUri ?? "" });
    const fromTool = await client.callTool({
      name: "get_deliberation",
      arguments: { job_id: submission.job_id },
    });
    expect(readJson(jobResource.contents)).toEqual(fromTool.structuredContent);

    const eventsResource = await client.readResource({ uri: eventsUri ?? "" });
    const tailed = await client.callTool({
      name: "tail_deliberation",
      arguments: { job_id: submission.job_id, after_seq: 0 },
    });
    expect(readJson(eventsResource.contents)).toMatchObject({
      job_id: submission.job_id,
      events: (tailed.structuredContent as { events: unknown }).events,
    });
  });

  it("reports a job that no longer exists as a failed read", async () => {
    const { client } = await harness();
    await expect(
      client.readResource({ uri: "rostra://deliberations/00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow();
  });

  it("pushes resources/updated for both URIs when the watcher observes a change", async () => {
    const { client, server, store } = await harness();
    const updated: string[] = [];
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      updated.push(notification.params.uri);
    });
    const watcher = new JobEventWatcher({
      store,
      notifier: {
        resourceUpdated: (uri) => {
          void server.server.sendResourceUpdated({ uri });
        },
      },
      intervalMs: 1_000,
      urisForJob: deliberationUris,
    });
    const submission = store.submit(request);
    watcher.tick();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    updated.length = 0;

    store.claimNext("build-a", "config-a");
    advance(store, submission.job_id, "running", "worker_started");
    watcher.tick();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(updated).toEqual([...deliberationUris(submission.job_id)]);
  });
});
