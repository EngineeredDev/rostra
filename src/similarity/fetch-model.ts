import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { AppError, errorMessage } from "../errors.js";
import { sha256File } from "../utils/hash-file.js";
import { loadMiniLmManifest } from "./local-minilm.js";

export async function fetchPinnedMiniLm(
  dataHome: string,
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<string> {
  const manifest = await loadMiniLmManifest();
  const modelDirectory = join(dataHome, "models", "minilm", manifest.revision);
  for (const [relativePath, expectedDigest] of Object.entries(manifest.files)) {
    const destination = join(modelDirectory, relativePath);
    try {
      if ((await sha256File(destination)) === expectedDigest) {
        continue;
      }
    } catch {
      // Missing and corrupt artifacts use the same pinned re-download path.
    }
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.part`;
    let handle;
    try {
      const url = new URL(
        `${manifest.model}/resolve/${manifest.revision}/${relativePath}`,
        "https://huggingface.co/",
      );
      url.searchParams.set("download", "true");
      const response = await fetchImplementation(url);
      if (!response.ok || response.body === null) {
        throw new Error(`HTTP ${response.status}`);
      }
      handle = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      for await (const value of response.body) {
        const chunk = z.instanceof(Uint8Array).parse(value);
        await handle.write(chunk);
        hash.update(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      const actualDigest = hash.digest("hex");
      if (actualDigest !== expectedDigest) {
        throw new Error(`Digest mismatch for ${relativePath}`);
      }
      await rename(temporary, destination);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw new AppError("similarity_model_unavailable", errorMessage(error));
    }
  }
  return modelDirectory;
}
