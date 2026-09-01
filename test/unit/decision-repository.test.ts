import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { queryDecisionsInputSchema } from "../../src/contracts/tools.js";
import { DecisionRepository } from "../../src/decisions/repository.js";
import { deriveWorkspaceIdentity } from "../../src/decisions/workspace.js";
import { openStorage } from "../../src/storage/database.js";
import { sha256File } from "../../src/utils/hash-file.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace-scoped decisions", () => {
  it("scopes direct reads, detects stale evidence, and appends outcomes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rostra-decisions-"));
    const otherRoot = await mkdtemp(join(tmpdir(), "rostra-other-"));
    roots.push(root, otherRoot);
    const evidencePath = join(root, "evidence.txt");
    await writeFile(evidencePath, "original");
    const db = await openStorage(join(root, "rostra.sqlite"));
    const workspace = await deriveWorkspaceIdentity(root);
    const decisionId = randomUUID();
    const supersedingId = randomUUID();
    const now = Date.now();
    db.prepare("INSERT INTO workspaces(id, canonical_root, created_at_ms) VALUES (?, ?, ?)")
      .run(workspace.id, workspace.canonicalRoot, now);
    for (const [id, question] of [[decisionId, "Use the file"], [supersedingId, "Replace the file"]]) {
      db.prepare(`
        INSERT INTO decisions(
          id, workspace_id, question, protocol, result_status, outcome_status,
          canonical_json, summary, execution_isolation, review_due_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'quick', 'partial', 'plurality', '{}', ?, 'builtin_confined', ?, ?, ?)
      `).run(id, workspace.id, question, question, now + 100_000, now, now);
    }
    db.prepare(`
      INSERT INTO claims(id, workspace_id, decision_id, claim_type, text, confidence, created_at_ms)
      VALUES ('claim-a', ?, ?, 'fact', 'The file stays unchanged', 1, ?)
    `).run(workspace.id, decisionId, now);
    const evidenceId = randomUUID();
    db.prepare(`
      INSERT INTO evidence(
        id, workspace_id, decision_id, source_type, canonical_uri, content_hash,
        captured_at_ms, tool_or_adapter, execution_isolation, redaction_status
      ) VALUES (?, ?, ?, 'file', ?, ?, ?, 'read_file', 'builtin_confined', 'none')
    `).run(evidenceId, workspace.id, decisionId, evidencePath, await sha256File(evidencePath), now);
    db.prepare(`
      INSERT INTO claim_evidence(workspace_id, claim_id, evidence_id, polarity, is_critical)
      VALUES (?, 'claim-a', ?, 'supports', 1)
    `).run(workspace.id, evidenceId);

    const repository = new DecisionRepository(db);
    const query = queryDecisionsInputSchema.parse({
      working_directory: root,
      decision_id: decisionId,
      include_stale: true,
    });
    await expect(repository.query(query)).resolves.toMatchObject({
      decisions: [{ id: decisionId, stale: false }],
    });
    await expect(repository.query(queryDecisionsInputSchema.parse({
      working_directory: otherRoot,
      decision_id: decisionId,
    }))).rejects.toMatchObject({ code: "decision_not_found" });

    await writeFile(evidencePath, "changed");
    const stale = await repository.query(query);
    expect(stale.decisions[0]).toMatchObject({ stale: true });
    expect(stale.decisions[0]?.warnings).toContain(`changed_evidence:${evidenceId}`);
    expect((await repository.listStale(root, 20)).decisions.map((decision) => decision.id)).toContain(decisionId);

    await repository.recordOutcome({
      working_directory: root,
      decision_id: decisionId,
      status: "confirmed",
      observed_at: "2026-01-01T00:00:00Z",
      measurements: { latency_ms: 10 },
    });
    await repository.recordOutcome({
      working_directory: root,
      decision_id: decisionId,
      status: "superseded",
      observed_at: "2026-01-02T00:00:00Z",
      measurements: {},
      superseding_decision_id: supersedingId,
    });
    expect(db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM outcomes").get()?.count).toBe(2);
    expect(db.prepare<[], { count: number }>(`
      SELECT COUNT(*) AS count FROM decision_relations WHERE relation_type = 'supersedes'
    `).get()?.count).toBe(1);
    db.close();
  });
});
