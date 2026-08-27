import { describe, expect, it } from "vitest";
import { decisionPacketSchema } from "../../src/contracts/results.js";
import { buildStagePrompt } from "../../src/prompts/stage.js";
import { renderDecisionSummary } from "../../src/summary/render.js";
import { renderTranscript } from "../../src/transcript/render.js";

const packet = decisionPacketSchema.parse({
  decision_id: "11111111-1111-4111-8111-111111111111",
  job_id: "22222222-2222-4222-8222-222222222222",
  question: "Which option?",
  protocol: "quick",
  participants: [
    { participant_id: "alpha", cli: "codex", model: "sol" },
    { participant_id: "beta", cli: "claude", model: "opus" },
    { participant_id: "gamma", cli: "gemini", model: "pro" },
  ],
  ballot: {
    outcome: "plurality",
    consensus_reached: false,
    participant_count: 3,
    quorum_required: 2,
    valid_ballots: 3,
    abstentions: 0,
    final_tally: { "option-a": 2, "option-b": 1 },
    winner: "option-a",
    minority_reports: [{ option_id: "option-b", votes: 1, rationale: "Lower risk" }],
    ballot_history: [],
  },
  convergence: {
    within_model_stability: 0.8,
    cross_model_agreement: 0.4,
    vote_stability: 1,
    disagreement_streak: 1,
    impasse: false,
    progress: { checks: 2, comparisons: 6, quorum_required: 2, valid_votes: 3, options: ["option-a", "option-b"] },
  },
  claims: [],
  evidence: [],
  predictions: [],
  agreements: ["The system needs a bounded queue."],
  assumptions: ["Traffic stays below the documented limit."],
  unresolved_claims: ["The provider latency is unknown."],
  experiment_proposals: [],
  execution_isolation: "host_unrestricted",
  created_at_ms: 1,
  review_due_at_ms: 2,
});

describe("decision packet rendering", () => {
  it("renders authoritative ballot status without manufacturing consensus", () => {
    const summary = renderDecisionSummary(packet);
    expect(summary).toContain("Outcome: plurality");
    expect(summary).toContain("Consensus reached: no");
    expect(summary).toContain("option-b: Lower risk");
    expect(summary).toContain("Execution isolation: host_unrestricted");
  });

  it("anonymizes prior outputs in prompts but retains identities in transcripts", () => {
    const prompt = buildStagePrompt({
      question: packet.question,
      stageKind: "final_ballot",
      visibility: "anonymized_prior",
      decisionOptions: [
        { id: "option-a", label: "Option A" },
        { id: "option-b", label: "Option B" },
      ],
      stance: "Prefer the lower-risk option",
      priorResponses: [
        { participantId: "beta", rawText: "beta response" },
        { participantId: "alpha", rawText: "alpha response" },
      ],
    });
    expect(prompt).toContain("P1: alpha response");
    expect(prompt).toContain("P2: beta response");
    expect(prompt).not.toContain("participant alpha");
    expect(prompt).toContain("AI_COUNSEL_RESULT:");
    expect(prompt).toContain("- option-a: Option A");
    expect(prompt).toContain("Assigned stance: Prefer the lower-risk option");
    const questionOnly = buildStagePrompt({
      question: packet.question,
      stageKind: "critique",
      visibility: "question_only",
      priorResponses: [{ participantId: "alpha", rawText: "hidden response" }],
    });
    expect(questionOnly).not.toContain("hidden response");
    const fullPrior = buildStagePrompt({
      question: packet.question,
      stageKind: "critique",
      visibility: "full_prior",
      priorResponses: [{ participantId: "alpha", rawText: "identified response" }],
    });
    expect(fullPrior).toContain("Participant alpha: identified response");

    const transcript = renderTranscript(packet, [
      { stageId: "analysis", participantId: "alpha", rawText: "raw alpha" },
      { stageId: "analysis", participantId: "beta", rawText: "raw beta" },
    ]);
    expect(transcript).toContain("alpha");
    expect(transcript).toContain("raw alpha");
    expect(transcript).toContain("Consensus reached: no");
  });
});
