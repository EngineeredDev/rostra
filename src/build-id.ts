import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";

const packageSchema = z.object({ version: z.string().min(1) });

async function manifestFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await manifestFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

export async function computeBuildId(): Promise<string> {
  const modulePath = fileURLToPath(import.meta.url);
  const distRoot = dirname(modulePath);
  const packageRoot = dirname(distRoot);
  const packageValue = packageSchema.parse(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")));
  const hash = createHash("sha256");
  for (const path of await manifestFiles(distRoot)) {
    hash.update(relative(distRoot, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return `${packageValue.version}+${hash.digest("hex")}`;
}

export async function computeConfigDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
