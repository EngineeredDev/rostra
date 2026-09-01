import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initialize } from "../../src/cli/init.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("first-run initialization", () => {
  it("creates the user files without replacing an existing configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-counsel-init-"));
    roots.push(root);
    const homeDir = join(root, "home");
    const fetchedFor: string[] = [];
    const fetchModel = (dataHome: string): Promise<string> => {
      fetchedFor.push(dataHome);
      return Promise.resolve(join(dataHome, "models", "minilm", "test"));
    };

    const first = await initialize({
      env: {},
      homeDir,
      packageRoot: process.cwd(),
      fetchModel,
    });
    expect(first).toEqual({
      configPath: join(homeDir, ".config", "ai-counsel", "config.yaml"),
      configCreated: true,
      dataHome: join(homeDir, ".local", "share", "ai-counsel"),
      modelDirectory: join(homeDir, ".local", "share", "ai-counsel", "models", "minilm", "test"),
    });
    expect((await stat(first.dataHome)).isDirectory()).toBe(true);

    const original = await readFile(first.configPath, "utf8");
    const customized = original.replace("max_concurrency: 2", "max_concurrency: 1");
    expect(customized).not.toBe(original);
    await writeFile(first.configPath, customized);
    const second = await initialize({
      env: {},
      homeDir,
      packageRoot: process.cwd(),
      fetchModel,
    });

    expect(second.configCreated).toBe(false);
    await expect(readFile(first.configPath, "utf8")).resolves.toBe(customized);
    expect(fetchedFor).toEqual([first.dataHome, first.dataHome]);
  });
});
