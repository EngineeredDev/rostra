import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import type { Config } from "../config/schema.js";
import { toolContracts } from "../contracts/tools.js";
import type { DecisionRepository } from "../decisions/repository.js";
import type { DecisionCiReviewer } from "../decision-ci/review.js";
import { AppError, errorMessage } from "../errors.js";
import type { JobEvent, JobSnapshot } from "../jobs/schema.js";
import { isTerminalStatus } from "../jobs/state-machine.js";
import type { JobStore } from "../jobs/store.js";
import { SystemProcessIdentityProvider } from "../process/identity.js";
import { PACKAGE_VERSION } from "../version.js";
import { parseJsonValue, type JsonValue } from "../utils/canonical-json.js";

interface McpRuntime {
  config: Config;
  store: JobStore;
  decisions: DecisionRepository;
  reviewer: DecisionCiReviewer;
  ensureSupervisor: () => Promise<void>;
}

type JsonObject = Record<string, JsonValue>;

function response(payload: JsonObject): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function failure(error: unknown, jobId?: string): CallToolResult {
  const payload: JsonObject = {
    status: "failed",
    error_type: error instanceof AppError ? error.code : "internal_error",
    message: errorMessage(error),
    ...(jobId === undefined ? {} : { job_id: jobId }),
  };
  return response(payload);
}

function jobProjection(job: JobSnapshot, includeAttempts: boolean, store: JobStore): JsonObject {
  return {
    job_id: job.job_id,
    status: job.status,
    question: job.question,
    created_at_ms: job.created_at_ms,
    updated_at_ms: job.updated_at_ms,
    row_version: job.row_version,
    execution_isolation: job.execution_isolation,
    ...(job.result_status === undefined ? {} : { result_status: job.result_status }),
    ...(job.result_json === undefined ? {} : { result: job.result_json }),
    ...(job.decision_id === undefined ? {} : { decision_id: job.decision_id }),
    ...(job.transcript_path === undefined ? {} : { transcript_path: job.transcript_path }),
    ...(job.cancellation_reason === undefined
      ? {}
      : { cancellation_reason: job.cancellation_reason }),
    ...(job.recovery_reason === undefined ? {} : { recovery_reason: job.recovery_reason }),
    ...(includeAttempts
      ? { attempts: parseJsonValue(JSON.parse(JSON.stringify(store.attempts(job.job_id)))) }
      : {}),
  };
}

const PROGRESS_BATCH = 100;

type ProgressEmitter = (event: JobEvent) => Promise<void>;

/** Emits `notifications/progress` keyed by `job_events.seq`, or nothing when the client sent no token. */
function progressEmitter(context: ServerContext): ProgressEmitter | undefined {
  const progressToken = context.mcpReq._meta?.progressToken;
  if (progressToken === undefined) {
    return undefined;
  }
  return async (event) => {
    await context.mcpReq.notify({
      method: "notifications/progress",
      params: { progressToken, progress: event.seq, message: event.event_type },
    });
  };
}

interface PollOptions<T> {
  timeoutSeconds: number;
  pollIntervalMs: number;
  afterSeq: number;
  probe: () => T;
  isDone: (value: T) => boolean;
  emit: ProgressEmitter | undefined;
}

/** Shared wait loop for both blocking tools: poll, report each newly appended event, return the last probe. */
async function pollJob<T>(store: JobStore, jobId: string, options: PollOptions<T>): Promise<T> {
  const deadline = Date.now() + options.timeoutSeconds * 1_000;
  const emit = options.emit;
  let seq = options.afterSeq;
  let value = options.probe();
  const report = async (): Promise<void> => {
    if (emit === undefined) {
      return;
    }
    for (const event of store.events(jobId, seq, PROGRESS_BATCH)) {
      seq = event.seq;
      await emit(event);
    }
  };
  await report();
  while (!options.isDone(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, options.pollIntervalMs));
    value = options.probe();
    await report();
  }
  return value;
}

export function createMcpServer(runtime: McpRuntime): McpServer {
  const server = new McpServer({ name: "ai-counsel", version: PACKAGE_VERSION });
  const sessionModels = new Map<string, string>();

  server.registerTool(
    "start_deliberation",
    {
      description: "Submit a durable deliberation job",
      inputSchema: toolContracts.start_deliberation.input,
      outputSchema: toolContracts.start_deliberation.output,
    },
    async (input) => {
      try {
        const submission = runtime.store.submit({
          ...input,
          session_models: Object.fromEntries(sessionModels),
        }, {
          ...(input.idempotency_key === undefined
            ? {}
            : { idempotencyKey: input.idempotency_key }),
          forceNew: input.force_new,
        });
        await runtime.ensureSupervisor();
        return response({
          job_id: submission.job_id,
          status: submission.status,
          deduplicated: submission.deduplicated,
          ...(submission.idempotency_key === undefined
            ? {}
            : { idempotency_key: submission.idempotency_key }),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_deliberations",
    {
      description: "List durable deliberation jobs",
      inputSchema: toolContracts.list_deliberations.input,
      outputSchema: toolContracts.list_deliberations.output,
    },
    (input) => {
      try {
        const page = runtime.store.list({
          ...(input.statuses === undefined ? {} : { statuses: input.statuses }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          limit: input.limit,
        });
        return response({
          jobs: page.jobs.map((job) => ({
            job_id: job.job_id,
            status: job.status,
            question: job.question,
            created_at_ms: job.created_at_ms,
            updated_at_ms: job.updated_at_ms,
            ...(job.result_status === undefined ? {} : { result_status: job.result_status }),
          })),
          ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_deliberation",
    {
      description: "Get one job by ID or idempotency key",
      inputSchema: toolContracts.get_deliberation.input,
      outputSchema: toolContracts.get_deliberation.output,
    },
    async (input, context) => {
      let jobId: string | undefined = input.job_id;
      try {
        let job = input.job_id === undefined
          ? runtime.store.getByIdempotencyKey(input.idempotency_key ?? "")
          : runtime.store.get(input.job_id);
        if (job === undefined) {
          throw new AppError("job_not_found", "No job matched the selector");
        }
        const id = job.job_id;
        jobId = id;
        if (input.wait_for_terminal && !isTerminalStatus(job.status)) {
          const requested = input.wait_timeout_seconds ?? runtime.config.jobs.wait_max_seconds;
          const timeout = Math.max(
            runtime.config.jobs.wait_min_seconds,
            Math.min(requested, runtime.config.jobs.wait_max_seconds),
          );
          job = await pollJob(runtime.store, id, {
            timeoutSeconds: timeout,
            pollIntervalMs: runtime.config.jobs.poll_interval_ms,
            afterSeq: 0,
            probe: () => runtime.store.get(id),
            isDone: (candidate) => isTerminalStatus(candidate.status),
            emit: progressEmitter(context),
          });
        }
        return response(jobProjection(job, input.include_attempts, runtime.store));
      } catch (error) {
        return failure(error, jobId);
      }
    },
  );

  server.registerTool(
    "tail_deliberation",
    {
      description: "Read job events after a sequence cursor",
      inputSchema: toolContracts.tail_deliberation.input,
      outputSchema: toolContracts.tail_deliberation.output,
    },
    async (input, context) => {
      try {
        const requested = input.wait_timeout_seconds ?? runtime.config.jobs.wait_max_seconds;
        const timeout = Math.max(
          runtime.config.jobs.wait_min_seconds,
          Math.min(requested, runtime.config.jobs.wait_max_seconds),
        );
        const events = await pollJob(runtime.store, input.job_id, {
          timeoutSeconds: timeout,
          pollIntervalMs: runtime.config.jobs.poll_interval_ms,
          afterSeq: input.after_seq,
          probe: () => runtime.store.events(input.job_id, input.after_seq, input.limit),
          isDone: (batch) => !input.wait_for_change || batch.length > 0,
          emit: input.wait_for_change ? progressEmitter(context) : undefined,
        });
        return response({
          job_id: input.job_id,
          events,
          next_seq: events.at(-1)?.seq ?? input.after_seq,
          timed_out: input.wait_for_change && events.length === 0,
        });
      } catch (error) {
        return failure(error, input.job_id);
      }
    },
  );

  server.registerTool(
    "cancel_deliberation",
    {
      description: "Request idempotent job cancellation",
      inputSchema: toolContracts.cancel_deliberation.input,
      outputSchema: toolContracts.cancel_deliberation.output,
    },
    async (input) => {
      try {
        const job = runtime.store.requestCancellation(input.job_id, input.reason);
        if (!isTerminalStatus(job.status)) {
          await runtime.ensureSupervisor();
        }
        return response({ job_id: job.job_id, status: job.status });
      } catch (error) {
        return failure(error, input.job_id);
      }
    },
  );

  server.registerTool(
    "resume_deliberation",
    {
      description: "Resolve a recovery-required uncertain attempt",
      inputSchema: toolContracts.resume_deliberation.input,
      outputSchema: toolContracts.resume_deliberation.output,
    },
    async (input) => {
      try {
        if (input.uncertain_attempt_policy === "cancel") {
          const identity = new SystemProcessIdentityProvider();
          for (const processRow of runtime.store.runningProcesses(input.job_id)) {
            const cleanup = await identity.terminate({
              pid: processRow.pid,
              startedAtMs: processRow.startedAtMs,
              ...(processRow.processGroupId === undefined
                ? {}
                : { processGroupId: processRow.processGroupId }),
            }, "SIGTERM");
            runtime.store.markProcessExited(
              processRow.processId,
              cleanup === "uncertain",
            );
          }
        }
        const job = runtime.store.resumeRecovery(input.job_id, input.uncertain_attempt_policy);
        if (job.status === "queued") {
          await runtime.ensureSupervisor();
        }
        return response({ job_id: job.job_id, status: job.status });
      } catch (error) {
        return failure(error, input.job_id);
      }
    },
  );

  server.registerTool(
    "list_models",
    {
      description: "List enabled configured models",
      inputSchema: toolContracts.list_models.input,
      outputSchema: toolContracts.list_models.output,
    },
    (input) => {
      const models = runtime.config.model_registry.models
        .filter((model) => model.enabled && (input.adapter === undefined || model.adapter === input.adapter))
        .map((model) => ({
          id: model.id,
          adapter: model.adapter,
          provider_family: model.provider_family,
          reasoning_efforts: model.reasoning_efforts,
          capabilities: model.capabilities,
          default: model.default,
        }));
      return response({ models, session_models: Object.fromEntries(sessionModels) });
    },
  );

  server.registerTool(
    "set_session_models",
    {
      description: "Set process-local default models by adapter",
      inputSchema: toolContracts.set_session_models.input,
      outputSchema: toolContracts.set_session_models.output,
    },
    (input) => {
      try {
        for (const [adapter, modelId] of Object.entries(input.models)) {
          if (modelId === null) {
            sessionModels.delete(adapter);
            continue;
          }
          const valid = runtime.config.model_registry.models.some(
            (model) => model.enabled && model.adapter === adapter && model.id === modelId,
          );
          if (!valid) {
            throw new AppError("model_not_allowed", `${modelId} is not enabled for ${adapter}`);
          }
          sessionModels.set(adapter, modelId);
        }
        return response({ session_models: Object.fromEntries(sessionModels) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_quality_metrics",
    {
      description: "Read durable model quality metrics",
      inputSchema: toolContracts.get_quality_metrics.input,
      outputSchema: toolContracts.get_quality_metrics.output,
    },
    (input) => {
      const metrics = runtime.store.listQuality({
        ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.domain === undefined ? {} : { domain: input.domain }),
      });
      return response({ metrics: parseJsonValue(JSON.parse(JSON.stringify(metrics))) });
    },
  );

  server.registerTool(
    "query_decisions",
    {
      description: "Query decisions in the current workspace",
      inputSchema: toolContracts.query_decisions.input,
      outputSchema: toolContracts.query_decisions.output,
    },
    async (input) => {
      try {
        const page = await runtime.decisions.query(input);
        const decisions = page.decisions.map((decision) =>
          input.format === "summary"
            ? {
                id: decision.id,
                summary: decision.summary,
                stale: decision.stale,
                warnings: decision.warnings,
              }
            : input.format === "detailed"
              ? { ...decision, canonical_result: undefined }
              : decision,
        );
        return response(parseJsonValue(JSON.parse(JSON.stringify({
          decisions,
          ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
        }))) as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_stale_decisions",
    {
      description: "List stale decisions in the current workspace",
      inputSchema: toolContracts.list_stale_decisions.input,
      outputSchema: toolContracts.list_stale_decisions.output,
    },
    async (input) => {
      try {
        const page = await runtime.decisions.listStale(
          input.working_directory,
          input.limit,
          input.cursor,
        );
        return response(parseJsonValue(JSON.parse(JSON.stringify(page))) as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "record_decision_outcome",
    {
      description: "Append an observed decision outcome",
      inputSchema: toolContracts.record_decision_outcome.input,
      outputSchema: toolContracts.record_decision_outcome.output,
    },
    async (input) => {
      try {
        const outcome = await runtime.decisions.recordOutcome({
          working_directory: input.working_directory,
          decision_id: input.decision_id,
          status: input.status,
          observed_at: input.observed_at,
          measurements: input.measurements,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          ...(input.superseding_decision_id === undefined
            ? {}
            : { superseding_decision_id: input.superseding_decision_id }),
        });
        return response(outcome);
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "review_decision_change",
    {
      description: "Review a Git change against workspace decisions",
      inputSchema: toolContracts.review_decision_change.input,
      outputSchema: toolContracts.review_decision_change.output,
    },
    async (input) => {
      try {
        return response(parseJsonValue(
          await runtime.reviewer.review(input),
        ) as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );
  return server;
}

export const durableToolNames: readonly string[] = [
  "start_deliberation",
  "list_deliberations",
  "get_deliberation",
  "tail_deliberation",
  "cancel_deliberation",
  "resume_deliberation",
  "list_models",
  "set_session_models",
  "get_quality_metrics",
  "query_decisions",
  "list_stale_decisions",
  "record_decision_outcome",
  "review_decision_change",
];

