import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loader.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const base = `
version: 2
adapters: {}
model_registry: { models: [] }
defaults: { protocol: quick }
protocols: {}
similarity: { provider: local_minilm }
execution: { allow_host_tools: false }
jobs: {}
storage: {}
decision_graph: {}
`;

async function write(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-counsel-http-config-"));
  roots.push(root);
  const path = join(root, "config.yaml");
  await writeFile(path, body);
  return path;
}

describe("http configuration", () => {
  it("defaults the whole section when the file omits it", async () => {
    const config = await loadConfig(await write(base));
    expect(config.http).toEqual({
      host: "127.0.0.1",
      port: 8787,
      max_subscriptions: 1024,
      keep_alive_ms: 15_000,
    });
  });

  it("keeps field defaults when the section is present but partial", async () => {
    const config = await loadConfig(await write(`${base}http: { port: 9000 }\n`));
    expect(config.http).toMatchObject({ host: "127.0.0.1", port: 9000, keep_alive_ms: 15_000 });
  });

  it("rejects an out-of-range port and unknown keys", async () => {
    await expect(loadConfig(await write(`${base}http: { port: 70000 }\n`)))
      .rejects.toMatchObject({ code: "invalid_config" });
    await expect(loadConfig(await write(`${base}http: { bind: "0.0.0.0" }\n`)))
      .rejects.toMatchObject({ code: "invalid_config" });
  });
});
