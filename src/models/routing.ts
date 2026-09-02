import type { ModelConfig } from "../config/schema.js";

export interface RoutingMetric {
  adapter: string;
  model: string;
  attempts: number;
  validAttempts: number;
  resolvedPredictions: number;
  brierSum: number;
  p75LatencyMs: number;
}

interface RoutingInput {
  models: readonly ModelConfig[];
  size: number;
  minProviderFamilies: number;
  maxCostUsd?: number;
  deadlineSeconds?: number;
  allowUnknownCost: boolean;
  domain: string;
  metrics: readonly RoutingMetric[];
  preferredModels?: Readonly<Record<string, string>>;
}

export interface SelectedParticipant {
  participant_id: string;
  cli: string;
  model: string;
  provider_family: string;
  estimated_cost_usd: number | null;
  estimated_latency_ms: number;
  score: number;
  score_breakdown: {
    calibration: number;
    success_rate: number;
    provider_family_novelty: number;
    cost_latency_efficiency: number;
  };
  selection_reason: string;
}

export interface CommitteeSelection {
  participants: SelectedParticipant[];
  excluded: { adapter: string; model: string; reason: string }[];
  limited: boolean;
  domain: string;
}

interface Candidate {
  config: ModelConfig;
  metric?: RoutingMetric;
  estimatedCost: number | null;
  latency: number;
  calibration: number;
  successRate: number;
  efficiency: number;
}

function normalized(value: number, minimum: number, maximum: number): number {
  return minimum === maximum ? 0.5 : (value - minimum) / (maximum - minimum);
}

export function selectAdaptiveCommittee(input: RoutingInput): CommitteeSelection {
  const excluded: CommitteeSelection["excluded"] = [];
  const candidates: Candidate[] = [];
  for (const model of input.models) {
    if (!model.enabled || !model.capabilities.includes("analysis")) {
      excluded.push({ adapter: model.adapter, model: model.id, reason: "missing_capability" });
      continue;
    }
    const knownCost =
      model.input_usd_per_million !== undefined && model.output_usd_per_million !== undefined;
    const estimatedCost = knownCost
      ? ((model.input_usd_per_million ?? 0) * 2_000) / 1_000_000 +
        ((model.output_usd_per_million ?? 0) * 1_000) / 1_000_000
      : null;
    if (input.maxCostUsd !== undefined && estimatedCost === null && !input.allowUnknownCost) {
      excluded.push({ adapter: model.adapter, model: model.id, reason: "unknown_cost" });
      continue;
    }
    const metric = input.metrics.find(
      (item) => item.adapter === model.adapter && item.model === model.id,
    );
    const latency = metric?.p75LatencyMs ?? model.default_latency_ms;
    if (input.deadlineSeconds !== undefined && latency > input.deadlineSeconds * 1_000) {
      excluded.push({ adapter: model.adapter, model: model.id, reason: "deadline" });
      continue;
    }
    const calibration =
      metric === undefined || metric.resolvedPredictions < 5
        ? 0.5
        : Math.max(0, Math.min(1, 1 - metric.brierSum / metric.resolvedPredictions));
    const successRate =
      metric === undefined ? 0.5 : (metric.validAttempts + 1) / (metric.attempts + 2);
    candidates.push({
      config: model,
      ...(metric === undefined ? {} : { metric }),
      estimatedCost,
      latency,
      calibration,
      successRate,
      efficiency: 0,
    });
  }

  const knownCosts = candidates
    .map((candidate) => candidate.estimatedCost)
    .filter((cost): cost is number => cost !== null);
  const latencies = candidates.map((candidate) => candidate.latency);
  const minimumCost = knownCosts.length === 0 ? 0 : Math.min(...knownCosts);
  const maximumCost = knownCosts.length === 0 ? 0 : Math.max(...knownCosts);
  const minimumLatency = latencies.length === 0 ? 0 : Math.min(...latencies);
  const maximumLatency = latencies.length === 0 ? 0 : Math.max(...latencies);
  for (const candidate of candidates) {
    const normalizedCost =
      candidate.estimatedCost === null
        ? 0.5
        : normalized(candidate.estimatedCost, minimumCost, maximumCost);
    const normalizedLatency = normalized(candidate.latency, minimumLatency, maximumLatency);
    candidate.efficiency = 0.5 * (1 - normalizedCost) + 0.5 * (1 - normalizedLatency);
  }

  const selected: SelectedParticipant[] = [];
  const selectedKeys = new Set<string>();
  const selectedFamilies = new Set<string>();
  let spent = 0;
  while (selected.length < input.size) {
    const remainingSlots = input.size - selected.length;
    const neededFamilies = Math.max(0, input.minProviderFamilies - selectedFamilies.size);
    const requireNewFamily = neededFamilies >= remainingSlots;
    const ranked = candidates
      .filter((candidate) => {
        const key = `${candidate.config.adapter}\0${candidate.config.id}`;
        if (selectedKeys.has(key)) return false;
        if (requireNewFamily && selectedFamilies.has(candidate.config.provider_family))
          return false;
        if (
          input.maxCostUsd !== undefined &&
          candidate.estimatedCost !== null &&
          spent + candidate.estimatedCost > input.maxCostUsd
        ) {
          return false;
        }
        return true;
      })
      .map((candidate) => {
        const novelty = selectedFamilies.has(candidate.config.provider_family) ? 0 : 1;
        const score =
          0.4 * candidate.calibration +
          0.25 * candidate.successRate +
          0.2 * novelty +
          0.15 * candidate.efficiency;
        return { candidate, novelty, score };
      })
      .sort((left, right) => {
        const leftPreferred =
          input.preferredModels?.[left.candidate.config.adapter] === left.candidate.config.id;
        const rightPreferred =
          input.preferredModels?.[right.candidate.config.adapter] === right.candidate.config.id;
        return (
          Number(rightPreferred) - Number(leftPreferred) ||
          right.score - left.score ||
          left.candidate.config.adapter.localeCompare(right.candidate.config.adapter) ||
          left.candidate.config.id.localeCompare(right.candidate.config.id)
        );
      });
    const choice = ranked[0];
    if (choice === undefined) {
      break;
    }
    const model = choice.candidate.config;
    selectedKeys.add(`${model.adapter}\0${model.id}`);
    selectedFamilies.add(model.provider_family);
    spent += choice.candidate.estimatedCost ?? 0;
    selected.push({
      participant_id: `adaptive_${selected.length + 1}`,
      cli: model.adapter,
      model: model.id,
      provider_family: model.provider_family,
      estimated_cost_usd: choice.candidate.estimatedCost,
      estimated_latency_ms: choice.candidate.latency,
      score: choice.score,
      score_breakdown: {
        calibration: choice.candidate.calibration,
        success_rate: choice.candidate.successRate,
        provider_family_novelty: choice.novelty,
        cost_latency_efficiency: choice.candidate.efficiency,
      },
      selection_reason:
        input.preferredModels?.[model.adapter] === model.id
          ? "session_default"
          : choice.candidate.metric === undefined
            ? "exploration_candidate"
            : "highest_calibrated_score",
    });
  }
  return {
    participants: selected,
    excluded,
    limited: selected.length < input.size || selectedFamilies.size < input.minProviderFamilies,
    domain: input.domain,
  };
}
