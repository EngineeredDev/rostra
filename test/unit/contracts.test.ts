import { describe, expect, it } from "vitest";
import {
  queryDecisionsInputSchema,
  startDeliberationInputSchema,
} from "../../src/contracts/tools.js";
import { extractStageSubmission } from "../../src/contracts/submissions.js";

const participant = {
  participant_id: "reviewer_a",
  cli: "codex",
  model: "gpt-5.6-sol",
  reasoning_effort: "high",
  stance: "neutral",
};

describe("shared wire contracts", () => {
  it("normalizes participant identifiers and rejects duplicates", () => {
    expect(() => startDeliberationInputSchema.parse({
      question: "Choose a design",
      working_directory: "/tmp/work",
      protocol: "quick",
      committee: { mode: "explicit" },
      participants: [participant, { ...participant, participant_id: "Reviewer_A" }],
    })).toThrow();
  });

  it("requires exactly one committee branch", () => {
    expect(() => startDeliberationInputSchema.parse({
      question: "Choose a design",
      working_directory: "/tmp/work",
      protocol: "quick",
      committee: { mode: "adaptive", size: 3, min_provider_families: 2 },
      participants: [participant, { ...participant, participant_id: "reviewer_b" }],
    })).toThrow();
  });

  it("requires exactly one decision selector", () => {
    expect(() => queryDecisionsInputSchema.parse({
      working_directory: "/tmp/work",
      query_text: "database",
      decision_id: "2b7c2a7b-0b57-4cb3-a136-086681f3e891",
    })).toThrow();
  });

  it("extracts one terminal structured result", () => {
    const raw = `Rationale first.\nROSTRA_RESULT: {"option_id":"option-a","confidence":0.8,"rationale":"bounded","continue_debate":false}`;
    const result = extractStageSubmission("final_ballot", raw);
    expect(result.submission).toMatchObject({ option_id: "option-a", confidence: 0.8 });
    expect(result.raw_text).toBe(raw);
  });
});
