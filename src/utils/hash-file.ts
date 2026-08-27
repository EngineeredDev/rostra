import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { z } from "zod/v4";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const value of createReadStream(path)) {
    const chunk: unknown = value;
    hash.update(z.instanceof(Buffer).parse(chunk));
  }
  return hash.digest("hex");
}
