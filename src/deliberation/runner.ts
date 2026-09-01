import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdapterRegistry, type RegistryOptions } from "../adapters/registry.js";
import { participantSchema, type Participant } from "../contracts/common.js";
import type { Config, StageKind } from "../config/schema.js";
import {
  analysisSubmissionSchema,
  ballotSubmissionSchema,
  critiqueSubmissionSchema,
  adjudicationSubmissionSchema,
  evidenceSubmissionSchema,
  experimentProposalSchema,
} from "../contracts/submissions.js";
import {
  decisionPacketSchema,
  deliberationResultSchema,
  type DecisionPacket,
  type CommitteeSelectionRecord,
  type EvidenceRecord,
} from "../contracts/results.js";
import { deriveWorkspaceIdentity } from "../decisions/workspace.js";
import { AppError, errorMessage } from "../errors.js";
import { executeEvidenceTool, extractEvidenceToolRequest } from "../evidence/protocol.js";
import { EvidenceWorkspace } from "../evidence/workspace.js";
import { JobStore } from "../jobs/store.js";
import type { StageRunner, WorkerExecutionResult } from "../jobs/worker.js";
import type { JobSnapshot } from "../jobs/schema.js";
import type { RunContext } from "../jobs/run-context.js";
import { ModelRegistry } from "../models/registry.js";
import { loadRoutingMetrics } from "../models/quality.js";
import { ProcessRunner, type ProcessRegistration } from "../process/runner.js";
import { selectAdaptiveCommittee } from "../models/routing.js";
import { buildStagePrompt } from "../prompts/stage.js";
import { createLocalMiniLmProvider } from "../similarity/local-minilm.js";
import { OpenAiCompatibleEmbeddingProvider } from "../similarity/openai-compatible.js";
import type { SimilarityProvider } from "../similarity/provider.js";
import { openStorage } from "../storage/database.js";
import { renderDecisionSummary } from "../summary/render.js";
import { renderTranscript } from "../transcript/render.js";
import { parseJsonValue, type JsonValue } from "../utils/canonical-json.js";
import { projectFinalBallots, type BallotStage, type RawBallot } from "./protocol/ballots.js";
import {
  analyzeConvergence,
  shouldStopProtocol,
  analyzeSemanticConvergence,
  type ConvergenceReport,
  type PositionSnapshot,
} from "./protocol/convergence.js";
import { protocolCheckpointSchema } from "./protocol/checkpoint.js";
import { invokeStructuredStage } from "./protocol/invoke-stage.js";
import { shippedPresets } from "./protocol/presets.js";
import { classifyExecutionResult } from "./protocol/result-status.js";
import {
  initialProtocolState,
  reduceProtocol,
  type ProtocolState,
} from "./protocol/state-machine.js";

interface ConfiguredRunnerOptions {
  config: Config;
  databasePath: string;
  adapterOptions?: RegistryOptions;
}

interface CompletedResponse {
  stageId: string;
  stageKind: StageKind;
  participantId: string;
  rawText: string;
  submission: unknown;
}

const analysisStage: Partial<Record<StageKind, true>> = {
  independent_analysis: true,
  proposal: true,
  revision: true,
  defense: true,
  premortem: true,
};
const critiqueStage: Partial<Record<StageKind, true>> = {
  critique: true,
  adversarial_attack: true,
  cross_examination: true,
};

function submissionEvidenceIds(kind: StageKind, submission: unknown): readonly string[] {
  if (kind === "evidence_collection") {
    return evidenceSubmissionSchema.parse(submission).evidence_ids;
  }
  if (kind === "adjudication") {
    return adjudicationSubmissionSchema.parse(submission).evidence_ids;
  }
  return [];
}
function convergencePosition(response: CompletedResponse): PositionSnapshot | undefined {
  if (analysisStage[response.stageKind] === true) {
    return { participantId: response.participantId, position: analysisSubmissionSchema.parse(response.submission).recommendation };
  }
  if (critiqueStage[response.stageKind] === true) {
    return { participantId: response.participantId, position: critiqueSubmissionSchema.parse(response.submission).objection };
  }
  if (response.stageKind === "evidence_collection") {
    return { participantId: response.participantId, position: evidenceSubmissionSchema.parse(response.submission).assessment };
  }
  if (response.stageKind === "adjudication") {
    return { participantId: response.participantId, position: adjudicationSubmissionSchema.parse(response.submission).rationale };
  }
  if (response.stageKind === "experiment_proposal") {
    return { participantId: response.participantId, position: experimentProposalSchema.parse(response.submission).hypothesis };
  }
  if (response.stageKind === "final_ballot") {
    const ballot = ballotSubmissionSchema.parse(response.submission);
    return {
      participantId: response.participantId,
      position: ballot.rationale,
      vote: ballot.option_id ?? ballot.option_label,
    };
  }
  return undefined;
}

function saveProtocolCheckpoint(input: {
  store: JobStore;
  jobId: string;
  label: string;
  state: ProtocolState;
  responses: readonly CompletedResponse[];
  selectedParticipants: readonly Participant[];
  committeeSelection: readonly CommitteeSelectionRecord[];
  committeeLimited: boolean;
  evidenceRecords: readonly EvidenceRecord[];
  convergenceChecks: readonly (readonly PositionSnapshot[])[];
  convergenceReport?: ConvergenceReport;
  failedParticipants: ReadonlySet<string>;
  ballotStages: readonly BallotStage[];
  executionIsolation: "builtin_confined" | "host_unrestricted";
  ballotProjection?: JsonValue;
}): void {
  const checkpoint = protocolCheckpointSchema.parse({
    protocol_state: input.state,
    completed_responses: input.responses,
    completed_attempts: input.store.attempts(input.jobId)
      .filter((attempt) => attempt.status === "succeeded")
      .map((attempt) => ({
        attempt_id: attempt.attempt_id,
        request_digest: attempt.request_digest,
      })),
    evidence_records: [...input.evidenceRecords].sort((left, right) =>
      left.evidence_id.localeCompare(right.evidence_id)),
    selected_participants: input.selectedParticipants,
    committee_selection: input.committeeSelection,
    committee_limited: input.committeeLimited,
    convergence_checks: input.convergenceChecks,
    ...(input.convergenceReport === undefined
      ? {}
      : { convergence_report: input.convergenceReport }),
    ballot_stages: input.ballotStages,
    ...(input.ballotProjection === undefined
      ? {}
      : { ballot_projection: input.ballotProjection }),
    execution_isolation: input.executionIsolation,
    failed_participants: [...input.failedParticipants].sort(),
    next_stage: input.state.currentStageIndex,
  });
  input.store.saveCheckpoint(input.jobId, input.label, parseJsonValue(checkpoint));
}

export class ConfiguredProtocolRunner implements StageRunner {
  readonly #config: Config;
  readonly #databasePath: string;
  readonly #adapterOptions: RegistryOptions;

  constructor(options: ConfiguredRunnerOptions) {
    this.#config = options.config;
    this.#databasePath = options.databasePath;
    this.#adapterOptions = options.adapterOptions ?? {};
  }

  async #similarityProvider(): Promise<SimilarityProvider> {
    const similarity = this.#config.similarity;
    const provider = similarity.provider === "local_minilm"
      ? await createLocalMiniLmProvider({
          dataHome: dirname(this.#databasePath),
          agreementThreshold: similarity.agreement_threshold,
          retrievalThreshold: similarity.retrieval_threshold,
          thresholdsRevision: similarity.thresholds_revision,
        })
      : new OpenAiCompatibleEmbeddingProvider({
          baseUrl: similarity.base_url,
          model: similarity.model,
          apiKeyEnvironment: similarity.api_key_env,
          agreementThreshold: similarity.agreement_threshold,
          retrievalThreshold: similarity.retrieval_threshold,
          thresholdsRevision: similarity.thresholds_revision,
          ...(this.#adapterOptions.environment === undefined
            ? {}
            : { environment: this.#adapterOptions.environment }),
          ...(this.#adapterOptions.fetch === undefined
            ? {}
            : { fetch: this.#adapterOptions.fetch }),
        });
    await provider.initialize();
    return provider;
  }

  async execute(job: JobSnapshot, context: RunContext): Promise<WorkerExecutionResult> {
    const similarityProvider = await this.#similarityProvider();
    const configuredProtocol = this.#config.protocols[job.request.protocol];
    const preset = shippedPresets[job.request.protocol];
    const protocolStages = configuredProtocol !== undefined
      ? configuredProtocol.stages.map((stage) => ({
          id: stage.id,
          kind: stage.kind,
          visibility: stage.visibility,
          allowedCapabilities: stage.allowed_capabilities,
          stoppingPolicy: stage.stopping_policy,
          minimumCompletions: stage.kind === "anonymous_aggregate"
            ? 0
            : stage.minimum_completions,
        }))
      : preset?.map((stage) => ({
          id: stage.id,
          kind: stage.kind,
          visibility: stage.visibility,
          allowedCapabilities: stage.allowedCapabilities,
          stoppingPolicy: stage.stoppingPolicy,
          minimumCompletions: stage.minimumCompletions,
        }));
    if (protocolStages === undefined) {
      throw new AppError("protocol_not_found", job.request.protocol);
    }
    const db = await openStorage(this.#databasePath, {
      busyTimeoutMs: this.#config.storage.busy_timeout_ms,
    });
    const store = new JobStore(db, {
      dedupeSuccessMs: this.#config.jobs.dedupe_success_ms,
      leaseMs: this.#config.jobs.lease_ms,
    });
    const baseAdapters = new AdapterRegistry(this.#config.adapters, this.#adapterOptions);
    const models = new ModelRegistry(this.#config, baseAdapters);
    const workspaceIdentity = await deriveWorkspaceIdentity(job.request.working_directory);
    const evidenceWorkspace = await EvidenceWorkspace.create(job.request.working_directory, {
      ignoredPaths: this.#config.execution.ignored_paths,
      maxBytes: this.#config.execution.evidence_max_bytes,
      timeoutMs: this.#config.execution.evidence_timeout_ms,
    });
    const routingDomain = job.request.domain_tags[0] ?? "general";
    const requiredStableChecks = configuredProtocol?.impasse_stability_checks ?? 2;
    const savedCheckpoint = store.latestCheckpoint(job.job_id);
    const restoredCheckpoint = savedCheckpoint === undefined
      ? undefined
      : protocolCheckpointSchema.parse(savedCheckpoint);
    for (const [adapter, model] of Object.entries(job.request.session_models)) {
      models.setSessionOverride(adapter, model);
    }
    const routingModels = this.#config.model_registry.models;
    let participants: Participant[];
    let committeeSelection: CommitteeSelectionRecord[];
    let committeeLimited: boolean;
    if (restoredCheckpoint !== undefined) {
      participants = restoredCheckpoint.selected_participants;
      committeeSelection = restoredCheckpoint.committee_selection;
      committeeLimited = restoredCheckpoint.committee_limited;
    } else if (job.request.committee.mode === "explicit") {
      participants = job.request.participants ?? [];
      committeeSelection = [];
      committeeLimited = false;
    } else {
      const selection = selectAdaptiveCommittee({
        models: routingModels,
        size: job.request.committee.size,
        minProviderFamilies: job.request.committee.min_provider_families,
        preferredModels: job.request.session_models,
        ...(job.request.max_cost_usd === undefined
          ? {}
          : { maxCostUsd: job.request.max_cost_usd }),
        ...(job.request.deadline_seconds === undefined
          ? {}
          : { deadlineSeconds: job.request.deadline_seconds }),
        allowUnknownCost: job.request.allow_unknown_cost,
        domain: routingDomain,
        metrics: loadRoutingMetrics(
          db,
          workspaceIdentity.id,
          routingModels,
          routingDomain,
        ),
      });
      participants = selection.participants.map((participant) => participantSchema.parse({
        participant_id: participant.participant_id,
        cli: participant.cli,
        model: participant.model,
      }));
      committeeSelection = selection.participants.map((participant) => ({
        participant_id: participant.participant_id,
        provider_family: participant.provider_family,
        estimated_cost_usd: participant.estimated_cost_usd,
        estimated_latency_ms: participant.estimated_latency_ms,
        score: participant.score,
        score_breakdown: participant.score_breakdown,
        selection_reason: participant.selection_reason,
      }));
      committeeLimited = selection.limited;
    }
    if (participants.length < 2) {
      store.close();
      throw new AppError("committee_unavailable", "The committee requires at least two eligible models");
    }
    for (const participant of participants) models.validateParticipant(participant);
    let protocolState: ProtocolState;
    let completedResponses: CompletedResponse[];
    let failedParticipants: Set<string>;
    let evidenceRecords: EvidenceRecord[];
    let convergenceChecks: PositionSnapshot[][];
    let convergenceReport: ConvergenceReport | undefined;
    let ballotStages: BallotStage[];
    let executionIsolation: "builtin_confined" | "host_unrestricted";
    if (restoredCheckpoint === undefined) {
      protocolState = initialProtocolState({
        protocol: job.request.protocol,
        participantIds: participants.map((participant) => participant.participant_id),
        stages: protocolStages.map((stage) => ({
          id: stage.id,
          kind: stage.kind,
          minimumCompletions: stage.minimumCompletions,
        })),
      });
      completedResponses = [];
      evidenceRecords = [];
      convergenceChecks = [];
      convergenceReport = undefined;
      failedParticipants = new Set();
      ballotStages = [];
      executionIsolation = "builtin_confined";
      saveProtocolCheckpoint({
        store,
        jobId: job.job_id,
        label: "context_loaded",
        state: protocolState,
        responses: completedResponses,
        evidenceRecords,
        selectedParticipants: participants,
        committeeSelection,
        committeeLimited,
        convergenceChecks,
        ...(convergenceReport === undefined ? {} : { convergenceReport }),
        failedParticipants,
        ballotStages,
        executionIsolation,
      });
    } else {
      const restored = restoredCheckpoint;
      protocolState = restored.protocol_state;
      completedResponses = restored.completed_responses;
      evidenceRecords = restored.evidence_records;
      convergenceChecks = restored.convergence_checks;
      convergenceReport = restored.convergence_report;
      failedParticipants = new Set(restored.failed_participants);
      ballotStages = restored.ballot_stages;
      executionIsolation = restored.execution_isolation;
    }

    try {
      for (
        let stageOrdinal = protocolState.currentStageIndex;
        stageOrdinal < protocolStages.length;
        stageOrdinal += 1
      ) {
        const stage = protocolStages[stageOrdinal];
        if (stage === undefined) {
          throw new AppError("invalid_protocol_state", `Missing stage ${stageOrdinal}`);
        }
        if (context.signal.aborted) {
          throw context.signal.reason;
        }
        protocolState = reduceProtocol(protocolState, { type: "begin_stage", stageId: stage.id });
        if (stage.kind === "anonymous_aggregate") {
          const recommendations = completedResponses
            .filter((response) => analysisStage[response.stageKind] === true)
            .map((response) => analysisSubmissionSchema.parse(response.submission).recommendation);
          const counts: Record<string, number> = {};
          for (const recommendation of recommendations) {
            counts[recommendation] = (counts[recommendation] ?? 0) + 1;
          }
          const submission = {
            agreements: Object.entries(counts).filter((entry) => entry[1] > 1).map((entry) => entry[0]),
            disagreements: Object.entries(counts).filter((entry) => entry[1] === 1).map((entry) => entry[0]),
            unresolved_claim_ids: [],
          };
          completedResponses.push({
            stageId: stage.id,
            stageKind: stage.kind,
            participantId: "aggregate",
            rawText: `ROSTRA_RESULT: ${JSON.stringify(submission)}`,
            submission,
          });
          protocolState = reduceProtocol(protocolState, {
            type: "complete_stage",
            stageId: stage.id,
          });
          saveProtocolCheckpoint({
            store,
            jobId: job.job_id,
            label: `after_${stage.id}`,
            state: protocolState,
            responses: completedResponses,
            evidenceRecords,
            selectedParticipants: participants,
            committeeSelection,
            committeeLimited,
            convergenceChecks,
            ...(convergenceReport === undefined ? {} : { convergenceReport }),
            failedParticipants,
            ballotStages,
            executionIsolation,
          });
          continue;
        }
        const priorResponses = completedResponses.map((response) => ({
          participantId: response.participantId,
          rawText: response.rawText,
        }));
        const stageResults = await Promise.all(participants.map(async (participant) => {
          try {
            const prompt = buildStagePrompt({
              question: job.question,
              stageKind: stage.kind,
              visibility: stage.visibility,
              priorResponses,
              ...(job.request.decision_options === undefined
                ? {}
                : { decisionOptions: job.request.decision_options }),
              ...(participant.stance === undefined ? {} : { stance: participant.stance }),
              allowedCapabilities: stage.allowedCapabilities,
            });
            const participantEvidence: EvidenceRecord[] = [];
            const result = await invokeStructuredStage({
              kind: stage.kind,
              prompt,
              invoke: async (attemptPrompt, attemptKind) => {
                const requestDigest = createHash("sha256").update(attemptPrompt).digest("hex");
                const attempt = store.createAttempt({
                  jobId: job.job_id,
                  stageId: stage.id,
                  participantId: participant.participant_id,
                  attemptKind,
                  ordinal: attemptKind === "stage" ? stageOrdinal : stageOrdinal + 1,
                  requestDigest,
                  executionIsolation:
                    this.#config.adapters[participant.cli]?.kind === "cli"
                      ? "host_unrestricted"
                      : "builtin_confined",
                });
                if (attempt.status === "succeeded" && attempt.raw_response !== undefined) {
                  if (attempt.execution_isolation === "host_unrestricted") {
                    executionIsolation = "host_unrestricted";
                  }
                  return attempt.raw_response;
                }
                let processRegistered = false;
                const registrar: ProcessRegistration = {
                  register: (identity) => {
                    store.markAttemptStarted(attempt.attempt_id, true);
                    store.registerProcess({
                      jobId: job.job_id,
                      attemptId: attempt.attempt_id,
                      pid: identity.pid,
                      pidStartedAtMs: identity.startedAtMs,
                      ...(identity.processGroupId === undefined
                        ? {}
                        : { processGroupId: identity.processGroupId }),
                      role: "adapter",
                    });
                    processRegistered = true;
                  },
                };
                const adapterConfig = this.#config.adapters[participant.cli];
                if (adapterConfig === undefined) {
                  throw new AppError("adapter_disabled", participant.cli);
                }
                if (adapterConfig.kind === "http") {
                  store.markAttemptStarted(attempt.attempt_id, true);
                }
                const registry = new AdapterRegistry(this.#config.adapters, {
                  ...this.#adapterOptions,
                  processRunner: new ProcessRunner({ registrar }),
                  maxStdoutBytes: this.#config.execution.max_stdout_bytes,
                  maxStderrBytes: this.#config.execution.max_stderr_bytes,
                  terminationGraceMs: this.#config.execution.termination_grace_ms,
                });
                const invocationStartedAt = Date.now();
                try {
                  const adapterResult = await registry.invoke({
                    adapter: participant.cli,
                    model: participant.model,
                    prompt: attemptPrompt,
                    workingDirectory: job.request.working_directory,
                    ...(participant.reasoning_effort === undefined
                      ? {}
                      : { reasoningEffort: participant.reasoning_effort }),
                    allowHostTools: this.#config.execution.allow_host_tools,
                    signal: context.signal,
                  });
                  if (adapterResult.executionIsolation === "host_unrestricted") {
                    executionIsolation = "host_unrestricted";
                  }
                  store.finishAttempt(attempt.attempt_id, "succeeded", {
                    responseId: randomUUID(),
                    responseDigest: createHash("sha256").update(adapterResult.text).digest("hex"),
                    rawResponse: adapterResult.text,
                  });
                  if (processRegistered) {
                    store.markAttemptProcessesExited(
                      attempt.attempt_id,
                      adapterResult.cleanupStatus === "uncertain",
                    );
                  }
                  store.recordQuality({
                    adapter: participant.cli,
                    model: participant.model,
                    domain: routingDomain,
                    valid_attempt: true,
                    latencyMs: Date.now() - invocationStartedAt,
                  });
                  return adapterResult.text;
                } catch (error) {
                  store.finishAttempt(attempt.attempt_id, "failed", {
                    errorType: error instanceof AppError ? error.code : "adapter_failed",
                    errorMessage: errorMessage(error),
                  });
                  if (processRegistered) {
                    store.markAttemptProcessesExited(attempt.attempt_id, true);
                  }
                  store.recordQuality({
                    adapter: participant.cli,
                    model: participant.model,
                    domain: routingDomain,
                    failure: true,
                    latencyMs: Date.now() - invocationStartedAt,
                  });
                  throw error;
                }
              },
              onToolRequest: async (rawText) => {
                const request = extractEvidenceToolRequest(rawText);
                if (request === undefined) return undefined;
                const execution = await executeEvidenceTool({
                  workspace: evidenceWorkspace,
                  request,
                  allowedCapabilities: new Set(stage.allowedCapabilities),
                });
                if (execution.evidence !== undefined) participantEvidence.push(execution.evidence);
                return execution.response;
              },
            });
            if (stage.kind === "final_ballot") {
              store.recordQuality({
                adapter: participant.cli,
                model: participant.model,
                domain: routingDomain,
                countAttempt: false,
                valid_ballot: true,
              });
            }
            return { participant, result, evidenceRecords: participantEvidence };
          } catch (error) {
            return { participant, error };
          }
        }));

        const stageBallots: RawBallot[] = [];
        const stageFailures: string[] = [];
        let completions = 0;
        for (const stageResult of stageResults) {
          if ("error" in stageResult) {
            failedParticipants.add(stageResult.participant.participant_id);
            stageFailures.push(
              `${stageResult.participant.participant_id}: ${errorMessage(stageResult.error)}`,
            );
            if (stage.kind === "final_ballot") {
              stageBallots.push({
                participantId: stageResult.participant.participant_id,
                failureReason: errorMessage(stageResult.error),
              });
            }
            continue;
          }
          completions += 1;
          evidenceRecords.push(...stageResult.evidenceRecords);
          const submission = parseJsonValue(stageResult.result.submission);
          const availableEvidenceIds = new Set(evidenceRecords.map((evidence) => evidence.evidence_id));
          for (const evidenceId of submissionEvidenceIds(stage.kind, submission)) {
            if (!availableEvidenceIds.has(evidenceId)) {
              throw new AppError("unknown_evidence_reference", evidenceId);
            }
          }
          protocolState = reduceProtocol(protocolState, {
            type: "record_response",
            stageId: stage.id,
            participantId: stageResult.participant.participant_id,
            responseId: randomUUID(),
            rawText: stageResult.result.rawText,
            submission,
          });
          completedResponses.push({
            stageId: stage.id,
            stageKind: stage.kind,
            participantId: stageResult.participant.participant_id,
            rawText: stageResult.result.rawText,
            submission: stageResult.result.submission,
          });
          if (stage.kind === "final_ballot") {
            const ballot = ballotSubmissionSchema.parse(stageResult.result.submission);
            stageBallots.push({
              participantId: stageResult.participant.participant_id,
              ...(ballot.option_id === undefined ? {} : { optionId: ballot.option_id }),
              ...(ballot.option_label === undefined ? {} : { optionLabel: ballot.option_label }),
              rationale: ballot.rationale,
              confidence: ballot.confidence,
            });
          }
        }
        if (completions < stage.minimumCompletions) {
          const detail = stageFailures.length === 0 ? "" : ` (${stageFailures.join("; ")})`;
          throw new AppError(
            "insufficient_stage_completions",
            `${stage.id} completed ${completions}/${stage.minimumCompletions}${detail}`,
          );
        }
        protocolState = reduceProtocol(protocolState, { type: "complete_stage", stageId: stage.id });
        if (stage.kind === "final_ballot") {
          ballotStages.push({
            stageId: stage.id,
            ordinal: stageOrdinal,
            completed: true,
            ballots: stageBallots,
          });
        }
        const currentResponses = participants.map((participant) =>
          completedResponses.find((response) =>
            response.stageId === stage.id && response.participantId === participant.participant_id));
        if (currentResponses.every((response) => response !== undefined)) {
          const snapshot = currentResponses
            .map((response) => convergencePosition(response))
            .filter((position): position is PositionSnapshot => position !== undefined);
          if (snapshot.length === participants.length) {
            convergenceChecks.push(snapshot);
            convergenceReport = await analyzeSemanticConvergence({
              participantIds: participants.map((participant) => participant.participant_id),
              checks: convergenceChecks,
              requiredStableChecks,
              provider: similarityProvider,
            });
          }
        }
        const currentBallot = projectFinalBallots({
          participantIds: participants.map((participant) => participant.participant_id),
          ...(job.request.decision_options === undefined
            ? {}
            : { decisionOptions: job.request.decision_options }),
          stages: ballotStages,
        });
        const stopAfterStage = shouldStopProtocol(
          stage.stoppingPolicy,
          convergenceReport,
          currentBallot.consensus_reached,
        );
        if (stopAfterStage && protocolState.status !== "completed") {
          protocolState = reduceProtocol(protocolState, { type: "stop_protocol" });
        }
        saveProtocolCheckpoint({
          store,
          jobId: job.job_id,
          label: `after_${stage.id}`,
          state: protocolState,
          responses: completedResponses,
          evidenceRecords,
          selectedParticipants: participants,
          committeeSelection,
          committeeLimited,
          convergenceChecks,
          ...(convergenceReport === undefined ? {} : { convergenceReport }),
          failedParticipants,
          ballotStages,
          executionIsolation,
        });
        if (stopAfterStage) break;
      }

      convergenceReport ??= analyzeConvergence({
        participantIds: participants.map((participant) => participant.participant_id),
        checks: convergenceChecks,
        requiredStableChecks,
        similarity: () => 0,
        agreementThreshold: similarityProvider.agreementThreshold,
      });
      const ballot = projectFinalBallots({
        participantIds: participants.map((participant) => participant.participant_id),
        ...(job.request.decision_options === undefined
          ? {}
          : { decisionOptions: job.request.decision_options }),
        stages: ballotStages,
      });
      saveProtocolCheckpoint({
        store,
        jobId: job.job_id,
        label: "final_projection",
        state: protocolState,
        responses: completedResponses,
        evidenceRecords,
        selectedParticipants: participants,
        committeeSelection,
        committeeLimited,
        convergenceChecks,
        convergenceReport,
        failedParticipants,
        ballotStages,
        executionIsolation,
        ballotProjection: parseJsonValue(ballot),
      });
      const analysisResponses = completedResponses
        .filter((response) => analysisStage[response.stageKind] === true);
      const analyses = analysisResponses
        .map((response) => analysisSubmissionSchema.parse(response.submission));
      const decisionPredictions = analysisResponses.flatMap((response) => {
        const analysis = analysisSubmissionSchema.parse(response.submission);
        const participant = participants.find(
          (item) => item.participant_id === response.participantId,
        );
        if (participant === undefined) return [];
        return analysis.predictions.map((prediction) => ({
          ...prediction,
          prediction_id: randomUUID(),
          participant_id: participant.participant_id,
          adapter: participant.cli,
          model: participant.model,
          domain: job.request.domain_tags[0] ?? "general",
        }));
      });
      const critiques = completedResponses
        .filter((response) => critiqueStage[response.stageKind] === true)
        .map((response) => critiqueSubmissionSchema.parse(response.submission));
      const recommendations = analyses.map((analysis) => analysis.recommendation);
      const recommendationCounts: Record<string, number> = {};
      for (const recommendation of recommendations) {
        recommendationCounts[recommendation] = (recommendationCounts[recommendation] ?? 0) + 1;
      }
      const agreements = Object.entries(recommendationCounts)
        .filter((entry) => entry[1] > 1)
        .map((entry) => entry[0]);
      let experimentProposals = completedResponses
        .filter((response) => response.stageKind === "experiment_proposal")
        .map((response) => experimentProposalSchema.parse(response.submission));
      if (
        experimentProposals.length === 0 &&
        (ballot.outcome === "tie" || ballot.outcome === "plurality") &&
        critiques.length > 0
      ) {
        experimentProposals = [experimentProposalSchema.parse({
          hypothesis: "One disputed option will outperform the other option.",
          discriminating_metric: "Measure the unresolved decision criterion.",
          setup: "Use an isolated representative fixture.",
          commands: [],
          expected_outcomes: ["The measured result favors one option."],
          estimated_cost: "unknown",
          safety_notes: ["Review the setup before any execution."],
          required_capabilities: [],
        })];
      }
      const decisionId = randomUUID();
      const nowMs = Date.now();
      const classification = classifyExecutionResult({
        protocolCompleted: protocolState.status === "completed",
        substantiveResponses: completedResponses.length,
        ballotOutcome: ballot.outcome,
        failedParticipants: [...failedParticipants],
        summaryFallback: committeeLimited,
        persistenceSucceeded: true,
      });
      if (classification.resultStatus === "failed") {
        throw new AppError("protocol_failed", "The protocol produced no substantive response");
      }
      const packet: DecisionPacket = decisionPacketSchema.parse({
        decision_id: decisionId,
        job_id: job.job_id,
        question: job.question,
        protocol: job.request.protocol,
        participants,
        committee_selection: committeeSelection,
        committee_limited: committeeLimited,
        ballot,
        convergence: convergenceReport,
        claims: analyses.flatMap((analysis) => analysis.claims),
        evidence: [...evidenceRecords].sort((left, right) =>
          left.evidence_id.localeCompare(right.evidence_id)),
        predictions: decisionPredictions,
        agreements,
        assumptions: [...new Set(analyses.flatMap((analysis) => analysis.assumptions))],
        unresolved_claims: critiques.map((critique) => critique.objection),
        failed_participants: [...failedParticipants].sort(),
        experiment_proposals: experimentProposals,
        execution_isolation: executionIsolation,
        created_at_ms: nowMs,
        review_due_at_ms:
          nowMs + this.#config.decision_graph.default_review_days * 86_400_000,
      });
      const summary = renderDecisionSummary(packet);
      const transcriptDirectory = join(dirname(this.#databasePath), "transcripts");
      await mkdir(transcriptDirectory, { recursive: true });
      const temporaryTranscript = join(transcriptDirectory, `${decisionId}.${randomUUID()}.tmp`);
      const transcriptPath = join(transcriptDirectory, `${decisionId}.md`);
      await writeFile(temporaryTranscript, renderTranscript(packet, completedResponses), {
        encoding: "utf8",
        mode: 0o600,
      });
      const root = workspaceIdentity.canonicalRoot;
      const workspaceId = workspaceIdentity.id;
      const result = deliberationResultSchema.parse({
        status: classification.resultStatus,
        decision: packet,
        summary,
        transcript_path: transcriptPath,
        failed_participants: packet.failed_participants,
        execution_isolation: executionIsolation,
      });
      return {
        status: classification.resultStatus,
        result: parseJsonValue(result),
        decisionId: packet.decision_id,
        transcriptPath,
        publication: {
          workspaceId,
          canonicalRoot: root,
          requestFingerprint: job.request_fingerprint,
          packet,
          summary,
          temporaryTranscriptPath: temporaryTranscript,
          transcriptPath,
        },
      };
    } finally {
      store.close();
    }
  }
}
