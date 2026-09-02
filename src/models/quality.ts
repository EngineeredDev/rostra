import { z } from "zod/v4";
import type { ModelConfig } from "../config/schema.js";
import type { StorageDatabase } from "../storage/database.js";
import type { RoutingMetric } from "./routing.js";

interface PredictionRow {
  probability: number;
  resolved_label: 0 | 1;
}

interface AttemptMetricRow {
  attempts: number;
  valid_attempts: number;
  latency_samples_json: string;
}

export function loadRoutingMetrics(
  db: StorageDatabase,
  workspaceId: string,
  models: readonly ModelConfig[],
  domain: string,
): RoutingMetric[] {
  return models.map((model) => {
    const predictions = db
      .prepare<[string, string, string, string], PredictionRow>(`
      SELECT probability, resolved_label FROM predictions
      WHERE workspace_id = ? AND adapter = ? AND model = ? AND domain = ?
        AND resolved_label IS NOT NULL
      ORDER BY resolved_at_ms DESC, id DESC
      LIMIT 100
    `)
      .all(workspaceId, model.adapter, model.id, domain);
    const brierSum = predictions.reduce(
      (sum, prediction) => sum + (prediction.probability - prediction.resolved_label) ** 2,
      0,
    );
    const attempts = db
      .prepare<[string, string, string], AttemptMetricRow>(`
      SELECT attempts, valid_attempts, latency_samples_json
      FROM quality_metrics WHERE adapter = ? AND model = ? AND domain = ?
    `)
      .get(model.adapter, model.id, domain);
    const latencies =
      attempts === undefined
        ? []
        : z
            .array(z.number().int().nonnegative())
            .parse(JSON.parse(attempts.latency_samples_json))
            .slice(-50)
            .sort((left, right) => left - right);
    return {
      adapter: model.adapter,
      model: model.id,
      attempts: attempts?.attempts ?? 0,
      validAttempts: attempts?.valid_attempts ?? 0,
      resolvedPredictions: predictions.length,
      brierSum,
      p75LatencyMs:
        latencies.length === 0
          ? model.default_latency_ms
          : (latencies[Math.floor((latencies.length - 1) * 0.75)] ?? model.default_latency_ms),
    };
  });
}
