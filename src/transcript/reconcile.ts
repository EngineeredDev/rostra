import { randomUUID } from "node:crypto";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { constants } from "node:fs";
import { deliberationResultSchema } from "../contracts/results.js";
import type { StorageDatabase } from "../storage/database.js";
import { renderTranscript } from "./render.js";

interface ArtifactRow {
  result_json: string;
  transcript_path: string;
}

export async function reconcileMissingTranscripts(db: StorageDatabase): Promise<number> {
  const rows = db
    .prepare<[], ArtifactRow>(`
    SELECT result_json, transcript_path FROM jobs
    WHERE status = 'succeeded' AND result_json IS NOT NULL AND transcript_path IS NOT NULL
    ORDER BY created_at_ms, job_id
  `)
    .all();
  let restored = 0;
  for (const row of rows) {
    try {
      await access(row.transcript_path, constants.R_OK);
      continue;
    } catch {
      const result = deliberationResultSchema.parse(JSON.parse(row.result_json));
      await mkdir(dirname(row.transcript_path), { recursive: true });
      const temporary = `${row.transcript_path}.${randomUUID()}.tmp`;
      await writeFile(temporary, renderTranscript(result.decision, []), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, row.transcript_path);
      restored += 1;
    }
  }
  return restored;
}
