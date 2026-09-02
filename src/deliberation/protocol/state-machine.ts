import type { StageKind } from "../../config/schema.js";
import { AppError } from "../../errors.js";
import type { JsonValue } from "../../utils/canonical-json.js";

export interface StageDefinition {
  id: string;
  kind: StageKind;
  minimumCompletions: number;
}

export interface StageResponse {
  participantId: string;
  responseId: string;
  rawText: string;
  submission: JsonValue;
}

export interface ProtocolState {
  protocol: string;
  participantIds: readonly string[];
  stages: readonly StageDefinition[];
  currentStageIndex: number;
  status: "ready" | "running" | "completed" | "failed";
  responses: Readonly<Record<string, Readonly<Record<string, StageResponse>>>>;
  completedStageIds: readonly string[];
  failure?: string | undefined;
}

type ProtocolCommand =
  | { type: "begin_stage"; stageId: string }
  | {
      type: "record_response";
      stageId: string;
      participantId: string;
      responseId: string;
      rawText: string;
      submission: JsonValue;
    }
  | { type: "complete_stage"; stageId: string }
  | { type: "stop_protocol" }
  | { type: "fail_protocol"; reason: string };

interface InitialProtocolInput {
  protocol: string;
  participantIds: readonly string[];
  stages: readonly StageDefinition[];
}

export function initialProtocolState(input: InitialProtocolInput): ProtocolState {
  if (new Set(input.participantIds).size !== input.participantIds.length) {
    throw new AppError("duplicate_participant", "Protocol participants must be unique");
  }
  if (new Set(input.stages.map((stage) => stage.id)).size !== input.stages.length) {
    throw new AppError("duplicate_stage", "Protocol stage IDs must be unique");
  }
  if (input.stages.length === 0) {
    throw new AppError("invalid_protocol", "Protocol requires at least one stage");
  }
  return {
    protocol: input.protocol,
    participantIds: [...input.participantIds],
    stages: input.stages.map((stage) => ({ ...stage })),
    currentStageIndex: 0,
    status: "ready",
    responses: {},
    completedStageIds: [],
  };
}

export function reduceProtocol(state: ProtocolState, command: ProtocolCommand): ProtocolState {
  if (state.status === "completed" || state.status === "failed") {
    throw new AppError("protocol_terminal", `Protocol is already ${state.status}`);
  }
  if (command.type === "stop_protocol") {
    if (state.status !== "ready" || state.completedStageIds.length === 0) {
      throw new AppError("invalid_protocol_transition", "Cannot stop before a completed stage");
    }
    return { ...state, currentStageIndex: state.stages.length, status: "completed" };
  }
  const stage = state.stages[state.currentStageIndex];
  if (stage === undefined) {
    throw new AppError("invalid_protocol_state", "Current stage is missing");
  }
  if (command.type === "fail_protocol") {
    return { ...state, status: "failed", failure: command.reason };
  }
  if (command.stageId !== stage.id) {
    throw new AppError(
      "unexpected_stage",
      `Expected stage ${stage.id}, received ${command.stageId}`,
    );
  }
  if (command.type === "begin_stage") {
    if (state.status !== "ready") {
      throw new AppError(
        "invalid_protocol_transition",
        `Cannot begin ${stage.id} from ${state.status}`,
      );
    }
    return { ...state, status: "running" };
  }
  if (command.type === "record_response") {
    if (state.status !== "running") {
      throw new AppError("invalid_protocol_transition", "Responses require a running stage");
    }
    if (!state.participantIds.includes(command.participantId)) {
      throw new AppError("unknown_participant", command.participantId);
    }
    const stageResponses = state.responses[stage.id] ?? {};
    if (stageResponses[command.participantId] !== undefined) {
      throw new AppError(
        "duplicate_stage_response",
        `${command.participantId} already completed ${stage.id}`,
      );
    }
    return {
      ...state,
      responses: {
        ...state.responses,
        [stage.id]: {
          ...stageResponses,
          [command.participantId]: {
            participantId: command.participantId,
            responseId: command.responseId,
            rawText: command.rawText,
            submission: command.submission,
          },
        },
      },
    };
  }
  const completionCount = Object.keys(state.responses[stage.id] ?? {}).length;
  if (state.status !== "running" || completionCount < stage.minimumCompletions) {
    throw new AppError(
      "insufficient_stage_completions",
      `${stage.id} requires ${stage.minimumCompletions} completions; received ${completionCount}`,
    );
  }
  const nextStageIndex = state.currentStageIndex + 1;
  return {
    ...state,
    currentStageIndex: nextStageIndex,
    status: nextStageIndex === state.stages.length ? "completed" : "ready",
    completedStageIds: [...state.completedStageIds, stage.id],
  };
}
