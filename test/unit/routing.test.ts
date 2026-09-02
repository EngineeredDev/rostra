import { describe, expect, it } from "vitest";
import {
  experimentProposalSchema,
  stageSubmissionSchemas,
} from "../../src/contracts/submissions.js";
import { shippedPresets } from "../../src/deliberation/protocol/presets.js";
import { selectAdaptiveCommittee } from "../../src/models/routing.js";

const models = [
  {
    id: "a",
    adapter: "openai",
    enabled: true,
    default: false,
    reasoning_efforts: [],
    capabilities: ["analysis"],
    provider_family: "openai",
    input_usd_per_million: 1,
    output_usd_per_million: 2,
    default_latency_ms: 100,
    domain_tags: [],
  },
  {
    id: "b",
    adapter: "claude",
    enabled: true,
    default: false,
    reasoning_efforts: [],
    capabilities: ["analysis"],
    provider_family: "anthropic",
    input_usd_per_million: 2,
    output_usd_per_million: 4,
    default_latency_ms: 200,
    domain_tags: [],
  },
  {
    id: "unknown-cost",
    adapter: "gemini",
    enabled: true,
    default: false,
    reasoning_efforts: [],
    capabilities: ["analysis"],
    provider_family: "google",
    default_latency_ms: 50,
    domain_tags: [],
  },
];

describe("declarative protocol presets", () => {
  it("ships exact deterministic stage sequences with complete output mappings", () => {
    expect(
      Object.fromEntries(
        Object.entries(shippedPresets).map(([name, preset]) => [
          name,
          preset.map((stage) => stage.kind),
        ]),
      ),
    ).toEqual({
      quick: ["independent_analysis", "final_ballot"],
      conference: ["independent_analysis", "critique", "revision", "final_ballot"],
      red_team: ["proposal", "adversarial_attack", "defense", "final_ballot"],
      delphi: ["independent_analysis", "anonymous_aggregate", "revision", "final_ballot"],
      premortem: ["premortem", "revision", "final_ballot"],
      evidence_tribunal: [
        "proposal",
        "evidence_collection",
        "cross_examination",
        "adjudication",
        "final_ballot",
      ],
    });
    for (const preset of Object.values(shippedPresets)) {
      for (const stage of preset) {
        expect(stageSubmissionSchemas[stage.kind]).toBeDefined();
      }
    }
  });

  it("keeps experiment commands as inert typed text", () => {
    expect(
      experimentProposalSchema.parse({
        hypothesis: "A test separates the options.",
        discriminating_metric: "latency",
        setup: "Use a fixture.",
        commands: ["run benchmark"],
        expected_outcomes: ["Option A is faster."],
        estimated_cost: "$1",
        safety_notes: ["Do not use production data."],
        required_capabilities: ["benchmark"],
      }).commands,
    ).toEqual(["run benchmark"]);
  });
});

describe("adaptive committee routing", () => {
  it("scores calibrated models, adds provider novelty, and excludes unknown cost", () => {
    const selection = selectAdaptiveCommittee({
      models: [...models],
      size: 2,
      minProviderFamilies: 2,
      maxCostUsd: 0.02,
      deadlineSeconds: 10,
      allowUnknownCost: false,
      domain: "general",
      metrics: [
        {
          adapter: "openai",
          model: "a",
          attempts: 8,
          validAttempts: 7,
          resolvedPredictions: 5,
          brierSum: 0.5,
          p75LatencyMs: 100,
        },
        {
          adapter: "claude",
          model: "b",
          attempts: 8,
          validAttempts: 6,
          resolvedPredictions: 5,
          brierSum: 1,
          p75LatencyMs: 200,
        },
      ],
    });
    expect(selection.participants.map((participant) => participant.model)).toEqual(["a", "b"]);
    expect(
      new Set(selection.participants.map((participant) => participant.provider_family)).size,
    ).toBe(2);
    const breakdown = selection.participants[0]?.score_breakdown;
    if (breakdown === undefined) throw new Error("Expected a selected participant");
    expect(Object.values(breakdown).every((value) => Number.isFinite(value))).toBe(true);
    expect(selection.excluded).toContainEqual({
      adapter: "gemini",
      model: "unknown-cost",
      reason: "unknown_cost",
    });
  });
});
