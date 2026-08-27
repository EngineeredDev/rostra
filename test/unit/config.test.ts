import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loader.js";
import { resolveConfigPath, resolveDataHome } from "../../src/config/paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "ai-counsel-config-"));
  roots.push(value);
  return value;
}

const minimal = `
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

describe("configuration v2", () => {
  it("uses explicit, XDG, home, then packaged precedence", async () => {
    const base = await root();
    const explicit = join(base, "explicit.yaml");
    const xdg = join(base, "xdg", "ai-counsel", "config.yaml");
    const home = join(base, "home", ".config", "ai-counsel", "config.yaml");
    const packaged = join(base, "package", "config.example.yaml");
    for (const path of [explicit, xdg, home, packaged]) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, minimal);
    }

    await expect(resolveConfigPath({ env: { AI_COUNSEL_CONFIG: explicit }, homeDir: join(base, "home"), packageRoot: join(base, "package") })).resolves.toBe(explicit);
    await expect(resolveConfigPath({ env: { XDG_CONFIG_HOME: join(base, "xdg") }, homeDir: join(base, "home"), packageRoot: join(base, "package") })).resolves.toBe(xdg);
    await expect(resolveConfigPath({ env: {}, homeDir: join(base, "home"), packageRoot: join(base, "package") })).resolves.toBe(home);
    await writeFile(home, "");
    await expect(resolveConfigPath({ env: {}, homeDir: join(base, "missing-home"), packageRoot: join(base, "package") })).resolves.toBe(packaged);
  });

  it("derives data home with explicit and XDG precedence", () => {
    expect(resolveDataHome({ env: { AI_COUNSEL_DATA_HOME: "/data/explicit" }, homeDir: "/home/user" })).toBe("/data/explicit");
    expect(resolveDataHome({ env: { XDG_DATA_HOME: "/data/xdg" }, homeDir: "/home/user" })).toBe("/data/xdg/ai-counsel");
    expect(resolveDataHome({ env: {}, homeDir: "/home/user" })).toBe("/home/user/.local/share/ai-counsel");
  });

  it("rejects legacy versions and unknown top-level sections", async () => {
    const base = await root();
    const legacy = join(base, "legacy.yaml");
    const unknown = join(base, "unknown.yaml");
    await writeFile(legacy, minimal.replace("version: 2", "version: 1"));
    await writeFile(unknown, `${minimal}\ncli_tools: {}`);

    await expect(loadConfig(legacy)).rejects.toMatchObject({ code: "unsupported_config_version" });
    await expect(loadConfig(unknown)).rejects.toMatchObject({ code: "invalid_config" });
  });
});
