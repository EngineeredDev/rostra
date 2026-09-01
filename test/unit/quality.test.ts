import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { loadRoutingMetrics } from "../../src/models/quality.js";
import { openStorage } from "../../src/storage/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("calibrated model quality", () => {
  it("uses the latest 100 predictions and p75 of the latest latency samples", async () => {
    const root = await mkdtemp(join(tmpdir(), "rostra-quality-"));
    roots.push(root);
    const db = await openStorage(join(root, "rostra.sqlite"));
    db.prepare("INSERT INTO workspaces(id, canonical_root, created_at_ms) VALUES ('w', ?, 1)")
      .run(root);
    db.prepare(`
      INSERT INTO decisions(
        id, workspace_id, question, protocol, result_status, outcome_status,
        canonical_json, summary, execution_isolation, review_due_at_ms, created_at_ms, updated_at_ms
      ) VALUES ('d', 'w', 'q', 'quick', 'partial', 'partial', '{}', 's',
        'builtin_confined', 9999999999999, 1, 1)
    `).run();
    for (let index = 0; index < 101; index += 1) {
      const id = `p-${index}`;
      db.prepare(`
        INSERT INTO claims(id, workspace_id, decision_id, claim_type, text, confidence, created_at_ms)
        VALUES (?, 'w', 'd', 'prediction', ?, 1, ?)
      `).run(id, id, index);
      db.prepare(`
        INSERT INTO predictions(
          id, workspace_id, decision_id, claim_id, participant_id, adapter, model, domain,
          probability, target_date, resolution_criteria, resolved_label, resolved_at_ms
        ) VALUES (?, 'w', 'd', ?, 'a', 'openai', 'model-a', 'general', ?,
          '2027-01-01', 'criterion', 1, ?)
      `).run(id, id, index === 0 ? 0 : 1, index);
    }
    db.prepare(`
      INSERT INTO quality_metrics(
        adapter, model, domain, attempts, valid_attempts, valid_ballots, abstentions,
        failures, latency_samples_json, input_tokens, output_tokens, resolved_predictions,
        brier_sum, updated_at_ms
      ) VALUES ('openai', 'model-a', 'general', 8, 7, 5, 1, 1, '[10,20,30,40]', 0, 0, 0, 0, 1)
    `).run();
    const model = configSchema.parse({
      version: 2,
      adapters: { openai: { kind: "http", base_url: "https://example.test", family: "openai" } },
      model_registry: { models: [{
        id: "model-a",
        adapter: "openai",
        capabilities: ["analysis"],
        provider_family: "openai",
        default_latency_ms: 100,
      }] },
      defaults: { protocol: "quick" },
      protocols: {},
      similarity: { provider: "local_minilm" },
      execution: { allow_host_tools: false },
      jobs: {},
      storage: {},
      decision_graph: {},
    }).model_registry.models[0];
    if (model === undefined) throw new Error("Expected model");
    expect(loadRoutingMetrics(db, "w", [model], "general")).toEqual([{
      adapter: "openai",
      model: "model-a",
      attempts: 8,
      validAttempts: 7,
      resolvedPredictions: 100,
      brierSum: 0,
      p75LatencyMs: 30,
    }]);
    db.close();
  });
});
