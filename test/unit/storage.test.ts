import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { APPLICATION_ID, USER_VERSION, openStorage } from "../../src/storage/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDatabase(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rostra-storage-"));
  roots.push(root);
  return join(root, "rostra.sqlite");
}

describe("single marked storage", () => {
  it("initializes missing and zero-byte databases with project markers", async () => {
    for (const precreate of [false, true]) {
      const path = await temporaryDatabase();
      if (precreate) await writeFile(path, "");
      const db = await openStorage(path, { busyTimeoutMs: 1234 });
      expect(db.pragma("application_id", { simple: true })).toBe(APPLICATION_ID);
      expect(db.pragma("user_version", { simple: true })).toBe(USER_VERSION);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("synchronous", { simple: true })).toBe(2);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get(),
      ).toBeDefined();
      db.close();
    }
  });

  it("rejects incompatible files without changing bytes or creating sidecars", async () => {
    const path = await temporaryDatabase();
    const legacy = new Database(path);
    legacy.exec("CREATE TABLE legacy(value TEXT)");
    legacy.close();
    const beforeDigest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    const beforeMtime = (await stat(path)).mtimeMs;

    await expect(openStorage(path)).rejects.toMatchObject({ code: "incompatible_database" });
    expect(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ).toBe(beforeDigest);
    expect((await stat(path)).mtimeMs).toBe(beforeMtime);
    await expect(stat(`${path}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${path}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
