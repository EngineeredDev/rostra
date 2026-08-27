import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceWorkspace, evidenceOperationNames } from "../../src/evidence/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), "ai-counsel-evidence-"));
  roots.push(base);
  const root = join(base, "workspace");
  const outside = join(base, "outside.txt");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "ignored"), { recursive: true });
  await writeFile(join(root, "src", "inside.txt"), "needle inside");
  await writeFile(join(root, "ignored", "secret.txt"), "needle ignored");
  await writeFile(outside, "outside secret");
  return { root, outside };
}

describe("root-confined evidence operations", () => {
  it("exposes typed operations without generic command execution", async () => {
    const { root } = await fixture();
    const workspace = await EvidenceWorkspace.create(root, {
      ignoredPaths: ["ignored"],
      maxBytes: 1024,
      maxResults: 10,
      timeoutMs: 5_000,
    });
    expect(evidenceOperationNames).toEqual([
      "read_file", "search_files", "list_files", "get_file_tree", "git_status", "git_diff",
    ]);
    await expect(workspace.readFile("src/inside.txt")).resolves.toMatchObject({
      text: "needle inside",
      relativePath: "src/inside.txt",
    });
    expect((await workspace.searchFiles("needle")).matches.map((match) => match.path)).toEqual([
      "src/inside.txt",
    ]);
    expect(await workspace.listFiles()).toEqual(["src/inside.txt"]);
  });

  it("rejects traversal, absolute paths, symlink escapes, and binary files", async () => {
    const { root, outside } = await fixture();
    await symlink(outside, join(root, "src", "escape.txt"));
    await writeFile(join(root, "src", "binary.bin"), Buffer.from([0, 1, 2]));
    const workspace = await EvidenceWorkspace.create(root);
    for (const path of ["../outside.txt", outside, "src/escape.txt"]) {
      await expect(workspace.readFile(path)).rejects.toMatchObject({ code: "evidence_path_escape" });
    }
    await expect(workspace.readFile("src/binary.bin")).rejects.toMatchObject({ code: "binary_file" });
  });

  it("rejects a symlink swap before reading outside content", async () => {
    const { root, outside } = await fixture();
    const target = join(root, "src", "inside.txt");
    const original = join(root, "src", "original.txt");
    const workspace = await EvidenceWorkspace.create(root, {
      beforeOpen: async () => {
        await rename(target, original);
        await symlink(outside, target);
      },
    });
    await expect(workspace.readFile("src/inside.txt")).rejects.toMatchObject({
      code: "evidence_path_changed",
    });
  });
});
