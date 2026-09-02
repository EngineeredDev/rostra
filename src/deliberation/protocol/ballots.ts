import type { DecisionOption } from "../../contracts/common.js";
import {
  ballotProjectionSchema,
  type BallotProjection,
  type BallotRecord,
} from "../../contracts/results.js";
import { AppError } from "../../errors.js";

export interface RawBallot {
  participantId: string;
  optionId?: string | undefined;
  optionLabel?: string | undefined;
  rationale?: string | undefined;
  confidence?: number | undefined;
  failureReason?: string | undefined;
}

export interface BallotStage {
  stageId: string;
  ordinal: number;
  completed: boolean;
  ballots: readonly RawBallot[];
}

interface ProjectionInput {
  participantIds: readonly string[];
  decisionOptions?: readonly DecisionOption[];
  stages: readonly BallotStage[];
}

function normalizeOptionLabel(label: string): string {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[\p{P}\p{S}\s]+/gu, "")
    .replace(/[\p{P}\p{S}\s]+$/gu, "");
}

function projectRecord(
  stageId: string,
  ballot: RawBallot,
  configuredIds: ReadonlySet<string> | undefined,
): BallotRecord {
  let optionId: string | undefined;
  let failureReason = ballot.failureReason;
  if (failureReason === undefined) {
    if (configuredIds !== undefined) {
      if (ballot.optionId !== undefined && configuredIds.has(ballot.optionId)) {
        optionId = ballot.optionId;
      } else {
        failureReason = "configured_option_id_required";
      }
    } else if (ballot.optionId !== undefined) {
      optionId = normalizeOptionLabel(ballot.optionId);
    } else if (ballot.optionLabel !== undefined) {
      optionId = normalizeOptionLabel(ballot.optionLabel);
    } else {
      failureReason = "missing_vote";
    }
    if (optionId === "" || optionId === "abstain") {
      optionId = undefined;
      failureReason = "invalid_vote";
    }
    if (
      optionId !== undefined &&
      (ballot.rationale === undefined || ballot.rationale.trim() === "")
    ) {
      optionId = undefined;
      failureReason = "missing_rationale";
    }
  }
  return {
    participant_id: ballot.participantId,
    stage_id: stageId,
    ...(optionId === undefined ? {} : { option_id: optionId }),
    ...(ballot.optionLabel === undefined ? {} : { option_label: ballot.optionLabel }),
    ...(ballot.confidence === undefined ? {} : { confidence: ballot.confidence }),
    ...(ballot.rationale === undefined ? {} : { rationale: ballot.rationale }),
    valid: optionId !== undefined,
    ...(failureReason === undefined ? {} : { failure_reason: failureReason }),
  };
}

export function projectFinalBallots(input: ProjectionInput): BallotProjection {
  if (new Set(input.participantIds).size !== input.participantIds.length) {
    throw new AppError("duplicate_participant", "Ballot participants must be unique");
  }
  const configuredIds =
    input.decisionOptions === undefined
      ? undefined
      : new Set(input.decisionOptions.map((option) => option.id));
  const ballotHistory = input.stages.flatMap((stage) =>
    stage.ballots.map((ballot) => projectRecord(stage.stageId, ballot, configuredIds)),
  );
  const finalStage = input.stages
    .filter((stage) => stage.completed)
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  const finalByParticipant = new Map<string, BallotRecord>();
  if (finalStage !== undefined) {
    for (const ballot of finalStage.ballots) {
      if (!input.participantIds.includes(ballot.participantId)) {
        throw new AppError("unknown_participant", ballot.participantId);
      }
      if (finalByParticipant.has(ballot.participantId)) {
        throw new AppError("duplicate_final_ballot", ballot.participantId);
      }
      finalByParticipant.set(
        ballot.participantId,
        projectRecord(finalStage.stageId, ballot, configuredIds),
      );
    }
  }

  const finalRecords = input.participantIds.map(
    (participantId) =>
      finalByParticipant.get(participantId) ?? {
        participant_id: participantId,
        stage_id: finalStage?.stageId ?? "none",
        valid: false,
        failure_reason: "missing_final_ballot",
      },
  );
  const validRecords = finalRecords.filter(
    (record): record is BallotRecord & { option_id: string } =>
      record.valid && record.option_id !== undefined,
  );
  const tally: Record<string, number> = {};
  for (const record of validRecords) {
    tally[record.option_id] = (tally[record.option_id] ?? 0) + 1;
  }
  const participantCount = input.participantIds.length;
  const quorumRequired = Math.ceil((2 * participantCount) / 3);
  const leaders = Object.entries(tally).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  const maximumVotes = leaders[0]?.[1] ?? 0;
  const tiedLeaders = leaders.filter((entry) => entry[1] === maximumVotes);
  let outcome: BallotProjection["outcome"];
  let winner: string | undefined;
  if (validRecords.length === 0) {
    outcome = "no_ballots";
  } else if (validRecords.length < quorumRequired) {
    outcome = "insufficient_quorum";
  } else if (tiedLeaders.length > 1) {
    outcome = "tie";
  } else {
    winner = leaders[0]?.[0];
    if (validRecords.length === participantCount && maximumVotes === participantCount) {
      outcome = "unanimous";
    } else if (maximumVotes >= quorumRequired) {
      outcome = "qualified_majority";
    } else {
      outcome = "plurality";
    }
  }

  const minorityReports = leaders
    .filter(([optionId]) => winner === undefined || optionId !== winner)
    .map(([optionId, votes]) => {
      const strongest = validRecords
        .filter((record) => record.option_id === optionId)
        .sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0))[0];
      return {
        option_id: optionId,
        votes,
        rationale: strongest?.rationale ?? "No rationale supplied",
      };
    });
  return ballotProjectionSchema.parse({
    outcome,
    consensus_reached: outcome === "unanimous" || outcome === "qualified_majority",
    participant_count: participantCount,
    quorum_required: quorumRequired,
    valid_ballots: validRecords.length,
    abstentions: participantCount - validRecords.length,
    final_tally: tally,
    ...(winner === undefined ? {} : { winner }),
    minority_reports: minorityReports,
    ballot_history: ballotHistory,
  });
}
