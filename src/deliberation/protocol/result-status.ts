import type { BallotOutcome } from "../../contracts/results.js";

interface ExecutionClassificationInput {
  protocolCompleted: boolean;
  substantiveResponses: number;
  ballotOutcome: BallotOutcome;
  failedParticipants: readonly string[];
  summaryFallback: boolean;
  persistenceSucceeded: boolean;
}

export type ExecutionClassification =
  | { resultStatus: "complete"; jobStatus: "succeeded" }
  | { resultStatus: "partial"; jobStatus: "succeeded" }
  | { resultStatus: "failed"; jobStatus: "failed" };

export function classifyExecutionResult(
  input: ExecutionClassificationInput,
): ExecutionClassification {
  if (input.substantiveResponses === 0 || !input.persistenceSucceeded) {
    return { resultStatus: "failed", jobStatus: "failed" };
  }
  const qualified =
    input.ballotOutcome === "unanimous" || input.ballotOutcome === "qualified_majority";
  if (
    input.protocolCompleted &&
    qualified &&
    input.failedParticipants.length === 0 &&
    !input.summaryFallback
  ) {
    return { resultStatus: "complete", jobStatus: "succeeded" };
  }
  return { resultStatus: "partial", jobStatus: "succeeded" };
}
