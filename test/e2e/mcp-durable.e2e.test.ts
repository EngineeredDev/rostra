import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Database from "better-sqlite3";
import { z } from "zod/v4";
import { afterEach, describe, expect, it } from "vitest";
import { durableToolNames } from "../../src/mcp/server.js";

const roots: string[] = [];
const supervisors = new Set<number>();
const objectSchema = z.record(z.string(), z.json());

function environment(overrides: Record<string, string>): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...inherited, ...overrides };
}

afterEach(async () => {
  const pids = [...supervisors];
  supervisors.clear();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
  }
  // Detached-process shutdown is a platform integration boundary; poll its observable identity.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const alive = pids.some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive) break;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ configPath: string; dataHome: string; env: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), "rostra-e2e-"));
  roots.push(root);
  const dataHome = join(root, "data");
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, `
version: 2
adapters: {}
model_registry: { models: [] }
defaults: { protocol: quick }
protocols:
  quick:
    stages:
      - { id: fake, kind: independent_analysis, minimum_completions: 1 }
similarity: { provider: local_minilm }
execution: { allow_host_tools: false }
jobs:
  max_concurrency: 2
  lease_ms: 1000
  heartbeat_ms: 20
  poll_interval_ms: 10
  dedupe_success_ms: 10000
  retention_ms: 10000
  wait_min_seconds: 1
  wait_max_seconds: 10
storage: { busy_timeout_ms: 1000 }
decision_graph: {}
`);
  return {
    configPath,
    dataHome,
    env: environment({
      ROSTRA_CONFIG: configPath,
      ROSTRA_DATA_HOME: dataHome,
      ROSTRA_WORKER_ENTRYPOINT: resolve("test/fixtures/fake-worker.mjs"),
    }),
  };
}

async function connect(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "rostra-e2e", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli/main.js")],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

const participants = [
  { participant_id: "reviewer_a", cli: "fake", model: "fake-a" },
  { participant_id: "reviewer_b", cli: "fake", model: "fake-b" },
];

describe("compiled durable MCP", () => {
  it("survives disconnects, deduplicates, waits, and cancels", async () => {
    const setup = await fixture();
    const idempotencyKey = randomUUID();
    const firstClient = await connect(setup.env);
    const tools = await firstClient.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...durableToolNames].sort());

    const started = objectSchema.parse((await firstClient.callTool({
      name: "start_deliberation",
      arguments: {
        question: "durable fake job",
        working_directory: process.cwd(),
        protocol: "quick",
        committee: { mode: "explicit" },
        participants,
        idempotency_key: idempotencyKey,
      },
    })).structuredContent);
    const jobId = z.uuid().parse(started.job_id);
    await firstClient.close();

    const secondClient = await connect(setup.env);
    const terminal = objectSchema.parse((await secondClient.callTool({
      name: "get_deliberation",
      arguments: {
        idempotency_key: idempotencyKey,
        wait_for_terminal: true,
        wait_timeout_seconds: 5,
      },
    })).structuredContent);
    expect(terminal).toMatchObject({ job_id: jobId, status: "succeeded" });
    expect(terminal.result).toMatchObject({ fake: true, status: "partial" });

    const repeated = objectSchema.parse((await secondClient.callTool({
      name: "start_deliberation",
      arguments: {
        question: "durable fake job",
        working_directory: process.cwd(),
        protocol: "quick",
        committee: { mode: "explicit" },
        participants,
        idempotency_key: idempotencyKey,
      },
    })).structuredContent);
    expect(repeated).toMatchObject({ job_id: jobId, deduplicated: true });

    const cancellable = objectSchema.parse((await secondClient.callTool({
      name: "start_deliberation",
      arguments: {
        question: "cancel this fake job",
        working_directory: process.cwd(),
        protocol: "quick",
        committee: { mode: "explicit" },
        participants,
        force_new: true,
      },
    })).structuredContent);
    const cancelJobId = z.uuid().parse(cancellable.job_id);
    await secondClient.callTool({
      name: "cancel_deliberation",
      arguments: { job_id: cancelJobId, reason: "e2e" },
    });
    const cancelled = objectSchema.parse((await secondClient.callTool({
      name: "get_deliberation",
      arguments: {
        job_id: cancelJobId,
        wait_for_terminal: true,
        wait_timeout_seconds: 5,
      },
    })).structuredContent);
    expect(cancelled.status).toBe("cancelled");
    await secondClient.close();

    const databasePath = join(setup.dataHome, "rostra.sqlite");
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const state = db.prepare<[], { pid: number }>("SELECT pid FROM supervisor_state WHERE singleton = 1").get();
    db.close();
    if (state !== undefined) supervisors.add(state.pid);
  });
});
