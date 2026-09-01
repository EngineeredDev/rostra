import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { DecisionCiReviewer } from "../../src/decision-ci/review.js";
import { DecisionRepository } from "../../src/decisions/repository.js";
import { JobStore } from "../../src/jobs/store.js";
import { createMcpServer, type McpRuntime } from "../../src/mcp/server.js";
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
  adapters: {
    codex: { kind: "cli", command: "codex", family: "openai" },
  },
  model_registry: {
    models: [
      { id: "sol", adapter: "codex", provider_family: "openai" },
      { id: "sol-mini", adapter: "codex", provider_family: "openai" },
    ],
  },
  defaults: { protocol: "quick" },
  protocols: {},
  similarity: { provider: "local_minilm" },
  execution: { allow_host_tools: false },
  jobs: {},
  storage: {},
  decision_graph: {},
});

async function runtime(): Promise<McpRuntime> {
  const root = await mkdtemp(join(tmpdir(), "rostra-session-models-"));
  roots.push(root);
  const db = await openStorage(join(root, "rostra.sqlite"));
  const store = new JobStore(db, { dedupeSuccessMs: 1_000, leaseMs: 5_000 });
  stores.push(store);
  return {
    config,
    store,
    decisions: new DecisionRepository(db),
    reviewer: new DecisionCiReviewer(db),
    sessionModels: new Map<string, string>(),
    ensureSupervisor: () => Promise.resolve(),
  };
}

async function connect(shared: McpRuntime): Promise<Client> {
  const server = createMcpServer(shared);
  const client = new Client({ name: "session-models-integration", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("session model overrides", () => {
  it("survives across separate tool round trips", async () => {
    const client = await connect(await runtime());
    await client.callTool({ name: "set_session_models", arguments: { models: { codex: "sol-mini" } } });
    const listed = await client.callTool({ name: "list_models", arguments: {} });

    expect(listed.structuredContent).toMatchObject({ session_models: { codex: "sol-mini" } });
  });

  it("is process scoped, so a second server instance over the same runtime sees it", async () => {
    const shared = await runtime();
    const first = await connect(shared);
    await first.callTool({ name: "set_session_models", arguments: { models: { codex: "sol-mini" } } });

    const second = await connect(shared);
    const listed = await second.callTool({ name: "list_models", arguments: {} });

    expect(listed.structuredContent).toMatchObject({ session_models: { codex: "sol-mini" } });
  });

  it("rejects a model that is not enabled for the adapter", async () => {
    const client = await connect(await runtime());
    const result = await client.callTool({
      name: "set_session_models",
      arguments: { models: { codex: "not-configured" } },
    });

    expect(result.structuredContent).toMatchObject({ error_type: "model_not_allowed" });
  });
});
