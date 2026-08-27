import { describe, expect, it } from "vitest";
import { projectFinalBallots } from "../../src/deliberation/protocol/ballots.js";
import {
  analyzeConvergence,
  shouldStopProtocol,
} from "../../src/deliberation/protocol/convergence.js";
import { classifyExecutionResult } from "../../src/deliberation/protocol/result-status.js";
import { invokeStructuredStage } from "../../src/deliberation/protocol/invoke-stage.js";
import {
  initialProtocolState,
  reduceProtocol,
} from "../../src/deliberation/protocol/state-machine.js";

const participants = ["a", "b", "c"];

describe("protocol state reducer", () => {
  it("advances only completed typed stages and rejects duplicate responses", () => {
    let state = initialProtocolState({
      protocol: "quick",
      participantIds: participants,
      stages: [
        { id: "analysis", kind: "independent_analysis", minimumCompletions: 2 },
        { id: "ballot", kind: "final_ballot", minimumCompletions: 2 },
      ],
    });
    state = reduceProtocol(state, { type: "begin_stage", stageId: "analysis" });
    state = reduceProtocol(state, {
      type: "record_response",
      stageId: "analysis",
      participantId: "a",
      responseId: "r1",
      rawText: "analysis a",
      submission: { recommendation: "a" },
    });
    expect(() => reduceProtocol(state, {
      type: "record_response",
      stageId: "analysis",
      participantId: "a",
      responseId: "r2",
      rawText: "duplicate",
      submission: {},
    })).toThrowError(expect.objectContaining({ code: "duplicate_stage_response" }));
    state = reduceProtocol(state, {
      type: "record_response",
      stageId: "analysis",
      participantId: "b",
      responseId: "r2",
      rawText: "analysis b",
      submission: { recommendation: "b" },
    });
    state = reduceProtocol(state, { type: "complete_stage", stageId: "analysis" });
    expect(state).toMatchObject({ currentStageIndex: 1, status: "ready" });
  });
});

describe("final ballot projection", () => {
  it("uses only each participant's highest completed ballot stage", () => {
    const projection = projectFinalBallots({
      participantIds: participants,
      stages: [
        {
          stageId: "round-one",
          ordinal: 1,
          completed: true,
          ballots: [
            { participantId: "a", optionLabel: "old-a", rationale: "old", confidence: 0.5 },
            { participantId: "b", optionLabel: "old-b", rationale: "old", confidence: 0.5 },
            { participantId: "c", optionLabel: "old-c", rationale: "old", confidence: 0.5 },
          ],
        },
        {
          stageId: "final",
          ordinal: 2,
          completed: true,
          ballots: [
            { participantId: "a", optionLabel: "Option-A", rationale: "best", confidence: 0.9 },
            { participantId: "b", optionLabel: " option-a! ", rationale: "also", confidence: 0.8 },
            { participantId: "c", failureReason: "invalid JSON" },
          ],
        },
      ],
    });
    expect(projection).toMatchObject({
      final_tally: { "option-a": 2 },
      abstentions: 1,
      valid_ballots: 2,
      outcome: "qualified_majority",
      consensus_reached: true,
    });
  });

  it("reports tie and no-ballot boundaries without consensus", () => {
    const tie = projectFinalBallots({
      participantIds: participants,
      stages: [{
        stageId: "final",
        ordinal: 1,
        completed: true,
        ballots: [
          { participantId: "a", optionLabel: "option-a", rationale: "a", confidence: 0.8 },
          { participantId: "b", optionLabel: "option-b", rationale: "b", confidence: 0.8 },
          { participantId: "c", failureReason: "missing" },
        ],
      }],
    });
    expect(tie).toMatchObject({ outcome: "tie", consensus_reached: false, abstentions: 1 });
    const none = projectFinalBallots({
      participantIds: participants,
      stages: [{
        stageId: "final",
        ordinal: 1,
        completed: true,
        ballots: participants.map((participantId) => ({ participantId, failureReason: "failed" })),
      }],
    });
    expect(none).toMatchObject({ outcome: "no_ballots", consensus_reached: false });
  });

  it("requires configured option IDs when decision options are supplied", () => {
    const projection = projectFinalBallots({
      participantIds: ["a", "b"],
      decisionOptions: [{ id: "safe", label: "Safe" }, { id: "fast", label: "Fast" }],
      stages: [{
        stageId: "final",
        ordinal: 1,
        completed: true,
        ballots: [
          { participantId: "a", optionLabel: "Safe", rationale: "label only", confidence: 0.9 },
          { participantId: "b", optionId: "safe", rationale: "ID", confidence: 0.9 },
        ],
      }],
    });
    expect(projection).toMatchObject({
      final_tally: { safe: 1 },
      abstentions: 1,
      outcome: "insufficient_quorum",
    });
  });
});

describe("convergence and result status", () => {
  it("detects a stable split impasse independently from semantic agreement", () => {
    const convergence = analyzeConvergence({
      participantIds: ["a", "b", "c", "d"],
      checks: [1, 2, 3].map(() => [
        { participantId: "a", position: "choose a", vote: "option-a" },
        { participantId: "b", position: "choose b", vote: "option-b" },
        { participantId: "c", position: "choose a", vote: "option-a" },
        { participantId: "d", position: "choose b", vote: "option-b" },
      ]),
      requiredStableChecks: 2,
      similarity: (left, right) => left === right ? 1 : 0,
      agreementThreshold: 0.9,
    });
    expect(convergence).toMatchObject({
      within_model_stability: 1,
      vote_stability: 1,
      disagreement_streak: 2,
      impasse: true,
    });
    expect(shouldStopProtocol("impasse", convergence, false)).toBe(true);
    expect(shouldStopProtocol("continue", convergence, false)).toBe(false);
    expect(Number.isFinite(convergence.cross_model_agreement)).toBe(true);
  });

  it("classifies substantive non-consensus as partial and empty work as failed", () => {
    expect(classifyExecutionResult({
      protocolCompleted: true,
      substantiveResponses: 2,
      ballotOutcome: "tie",
      failedParticipants: [],
      summaryFallback: false,
      persistenceSucceeded: true,
    })).toEqual({ resultStatus: "partial", jobStatus: "succeeded" });
    expect(classifyExecutionResult({
      protocolCompleted: false,
      substantiveResponses: 0,
      ballotOutcome: "no_ballots",
      failedParticipants: participants,
      summaryFallback: false,
      persistenceSucceeded: false,
    })).toEqual({ resultStatus: "failed", jobStatus: "failed" });
  });
});

describe("structured stage invocation", () => {
  it("retries extraction once in an isolated attempt", async () => {
    const attempts: string[] = [];
    const result = await invokeStructuredStage({
      kind: "final_ballot",
      prompt: "vote",
      invoke: (prompt, attemptKind) => {
        attempts.push(`${attemptKind}:${prompt}`);
        return Promise.resolve(attempts.length === 1
          ? "invalid"
          : 'fixed\nAI_COUNSEL_RESULT: {"option_id":"a","confidence":1,"rationale":"ok","continue_debate":false}');
      },
    });
    expect(result.submission).toMatchObject({ option_id: "a" });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toContain("structured_retry");
  });
});
