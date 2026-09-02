import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Database from "better-sqlite3";
import { z } from "zod/v4";
import { afterEach, describe, expect, it } from "vitest";
import { durableToolNames } from "../../src/mcp/server.js";

const roots: string[] = [];
const children = new Set<ChildProcess>();
const supervisors = new Set<number>();
const objectSchema = z.record(z.string(), z.json());

function environment(overrides: Record<string, string>): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...inherited, ...overrides };
}

async function reap(pids: readonly number[]): Promise<void> {
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
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

afterEach(async () => {
  const pids = [...supervisors];
  supervisors.clear();
  const spawned = [...children];
  children.clear();
  const exits = spawned.map((child) => waitForExit(child));
  for (const child of spawned) {
    child.kill("SIGTERM");
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
  }
  await Promise.all(exits);
  await reap(pids);
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 50,
    retryDelay: 100,
  })));
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePromise) => probe.listen(0, "127.0.0.1", resolvePromise));
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  return port;
}

async function serve(): Promise<{ endpoint: string; dataHome: string }> {
  const root = await mkdtemp(join(tmpdir(), "rostra-http-e2e-"));
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
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [resolve("dist/cli/main.js"), "serve", "--http", "--port", String(port)],
    {
      cwd: process.cwd(),
      env: environment({
        ROSTRA_CONFIG: configPath,
        ROSTRA_DATA_HOME: dataHome,
        ROSTRA_WORKER_ENTRYPOINT: resolve("test/fixtures/fake-worker.mjs"),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  const endpoint = await new Promise<string>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("serve --http did not report a listener")), 20_000);
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const match = /listening on (\S+)/.exec(buffered);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolvePromise(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve --http exited with ${String(code)}`));
    });
  });
  return { endpoint, dataHome };
}

async function connect(endpoint: string, modern = false): Promise<Client> {
  const client = new Client(
    { name: "rostra-http-e2e", version: "1" },
    // subscriptions/listen exists only on the 2026-07-28 era; the default is the 2025 handshake,
    // which the other cases keep exercising because the endpoint still serves it.
    modern ? { versionNegotiation: { mode: "auto" } } : {},
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  return client;
}

const participants = [
  { participant_id: "reviewer_a", cli: "fake", model: "fake-a" },
  { participant_id: "reviewer_b", cli: "fake", model: "fake-b" },
];

describe("compiled MCP over Streamable HTTP", () => {
  it("serves the durable tool surface and runs a deliberation to a terminal state", async () => {
    const { endpoint, dataHome } = await serve();
    const client = await connect(endpoint);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...durableToolNames].sort());

    const started = objectSchema.parse((await client.callTool({
      name: "start_deliberation",
      arguments: {
        question: "http fake job",
        working_directory: process.cwd(),
        protocol: "quick",
        committee: { mode: "explicit" },
        participants,
      },
    })).structuredContent);
    expect(started).toHaveProperty("job_id");
    const jobId = z.uuid().parse(started.job_id);

    const terminal = objectSchema.parse((await client.callTool({
      name: "get_deliberation",
      arguments: { job_id: jobId, wait_for_terminal: true, wait_timeout_seconds: 10 },
    })).structuredContent);
    expect(terminal).toMatchObject({ job_id: jobId, status: "succeeded" });

    await client.close();

    const db = new Database(join(dataHome, "rostra.sqlite"), { readonly: true, fileMustExist: true });
    const state = db.prepare<[], { pid: number }>("SELECT pid FROM supervisor_state WHERE singleton = 1").get();
    db.close();
    if (state !== undefined) supervisors.add(state.pid);
  });

  it("keeps session model overrides across separate requests", async () => {
    const { endpoint } = await serve();
    const client = await connect(endpoint);

    await client.callTool({ name: "set_session_models", arguments: { models: {} } });
    const listed = objectSchema.parse((await client.callTool({
      name: "list_models",
      arguments: {},
    })).structuredContent);
    expect(listed).toMatchObject({ session_models: {} });

    await client.close();
  });

  it("delivers resources/updated only to the subscribed URI", async () => {
    const { endpoint, dataHome } = await serve();
    const subscriber = await connect(endpoint, true);
    const bystander = await connect(endpoint, true);

    const started = objectSchema.parse((await subscriber.callTool({
      name: "start_deliberation",
      arguments: {
        question: "subscribed fake job",
        working_directory: process.cwd(),
        protocol: "quick",
        committee: { mode: "explicit" },
        participants,
      },
    })).structuredContent);
    expect(started).toHaveProperty("job_id");
    const jobId = z.uuid().parse(started.job_id);
    const jobUri = `rostra://deliberations/${jobId}`;

    const observed: string[] = [];
    const ignored: string[] = [];
    subscriber.setNotificationHandler("notifications/resources/updated", (notification) => {
      observed.push(notification.params.uri);
    });
    bystander.setNotificationHandler("notifications/resources/updated", (notification) => {
      ignored.push(notification.params.uri);
    });
    const subscription = await subscriber.listen({ resourceSubscriptions: [jobUri] });
    const unrelated = await bystander.listen({
      resourceSubscriptions: ["rostra://deliberations/00000000-0000-4000-8000-000000000000"],
    });

    const terminal = objectSchema.parse((await subscriber.callTool({
      name: "get_deliberation",
      arguments: { job_id: jobId, wait_for_terminal: true, wait_timeout_seconds: 10 },
    })).structuredContent);
    expect(terminal).toMatchObject({ job_id: jobId, status: "succeeded" });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 200));

    expect(observed).toContain(jobUri);
    expect(observed).not.toContain(`${jobUri}/events`);
    expect(ignored).toEqual([]);

    await subscription.close();
    await unrelated.close();
    await subscriber.close();
    await bystander.close();

    const db = new Database(join(dataHome, "rostra.sqlite"), { readonly: true, fileMustExist: true });
    const state = db.prepare<[], { pid: number }>("SELECT pid FROM supervisor_state WHERE singleton = 1").get();
    db.close();
    if (state !== undefined) supervisors.add(state.pid);
  });

  it("rejects non-loopback origins, non-POST methods, and unknown paths", async () => {
    const { endpoint } = await serve();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

    const crossOrigin = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.test" },
      body,
    });
    expect(crossOrigin.status).toBe(403);

    const wrongMethod = await fetch(endpoint, { method: "GET" });
    expect(wrongMethod.status).toBe(405);

    const unknownPath = await fetch(new URL("/other", endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(unknownPath.status).toBe(404);
  });
});
