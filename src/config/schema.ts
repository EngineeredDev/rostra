import { z } from "zod/v4";
import { evidenceOperationNames } from "../evidence/operations.js";

const nonempty = z.string().trim().min(1);
const slug = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const positiveInt = z.number().int().positive();
const nonnegative = z.number().nonnegative();

export const cliAdapterConfigSchema = z.strictObject({
  kind: z.literal("cli"),
  enabled: z.boolean().default(true),
  command: nonempty,
  args: z.array(z.string()).default([]),
  timeout_seconds: positiveInt.default(300),
  max_retries: z.number().int().min(0).max(5).default(1),
  environment: z.array(nonempty).default([]),
  family: nonempty,
});

export const httpAdapterConfigSchema = z.strictObject({
  kind: z.literal("http"),
  enabled: z.boolean().default(true),
  base_url: z.url(),
  endpoint: nonempty.default("/v1/chat/completions"),
  api_key_env: nonempty.optional(),
  timeout_seconds: positiveInt.default(120),
  max_retries: z.number().int().min(0).max(5).default(2),
  family: nonempty,
  headers: z.record(z.string(), z.string()).default({}),
});

export const adapterConfigSchema = z.discriminatedUnion("kind", [
  cliAdapterConfigSchema,
  httpAdapterConfigSchema,
]);

export const modelConfigSchema = z.strictObject({
  id: nonempty,
  adapter: slug,
  enabled: z.boolean().default(true),
  default: z.boolean().default(false),
  reasoning_efforts: z.array(nonempty).default([]),
  capabilities: z.array(slug).default([]),
  provider_family: nonempty,
  input_usd_per_million: nonnegative.optional(),
  output_usd_per_million: nonnegative.optional(),
  default_latency_ms: positiveInt.default(30_000),
  domain_tags: z.array(slug).default([]),
});

export const stageKindSchema = z.enum([
  "independent_analysis",
  "critique",
  "proposal",
  "adversarial_attack",
  "defense",
  "anonymous_aggregate",
  "revision",
  "premortem",
  "evidence_collection",
  "cross_examination",
  "adjudication",
  "experiment_proposal",
  "final_ballot",
]);

export const protocolStageConfigSchema = z.strictObject({
  id: slug,
  kind: stageKindSchema,
  visibility: z.enum(["question_only", "anonymized_prior", "full_prior"]).default("anonymized_prior"),
  allowed_capabilities: z.array(z.enum(evidenceOperationNames)).default([]),
  minimum_completions: positiveInt.default(1),
  stopping_policy: z.enum(["continue", "qualified_decision", "impasse"]).default("continue"),
});

export const protocolConfigSchema = z.strictObject({
  stages: z.array(protocolStageConfigSchema).min(1),
  impasse_stability_checks: positiveInt.default(2),
});

const localSimilaritySchema = z.strictObject({
  provider: z.literal("local_minilm"),
  agreement_threshold: z.number().min(0).max(1).default(0.82),
  retrieval_threshold: z.number().min(0).max(1).default(0.72),
  thresholds_revision: nonempty.default("minilm-v1"),
});

const remoteSimilaritySchema = z.strictObject({
  provider: z.literal("openai_compatible"),
  base_url: z.url(),
  model: nonempty,
  api_key_env: nonempty,
  agreement_threshold: z.number().min(0).max(1),
  retrieval_threshold: z.number().min(0).max(1),
  thresholds_revision: nonempty,
});

export const configSchema = z.strictObject({
  version: z.literal(2),
  adapters: z.record(slug, adapterConfigSchema),
  model_registry: z.strictObject({
    models: z.array(modelConfigSchema),
  }),
  defaults: z.strictObject({
    protocol: slug.default("quick"),
    summary_model: nonempty.optional(),
  }),
  protocols: z.record(slug, protocolConfigSchema),
  similarity: z.discriminatedUnion("provider", [localSimilaritySchema, remoteSimilaritySchema]),
  execution: z.strictObject({
    allow_host_tools: z.boolean().default(false),
    max_stdout_bytes: positiveInt.default(1_048_576),
    max_stderr_bytes: positiveInt.default(262_144),
    termination_grace_ms: positiveInt.default(5_000),
    evidence_timeout_ms: positiveInt.default(10_000),
    evidence_max_bytes: positiveInt.default(1_048_576),
    ignored_paths: z.array(nonempty).default([".git", "node_modules", "dist"]),
  }),
  jobs: z.strictObject({
    max_concurrency: positiveInt.default(2),
    lease_ms: positiveInt.default(30_000),
    heartbeat_ms: positiveInt.default(5_000),
    poll_interval_ms: positiveInt.default(100),
    dedupe_success_ms: positiveInt.default(86_400_000),
    retention_ms: positiveInt.default(2_592_000_000),
    wait_min_seconds: positiveInt.default(1),
    wait_max_seconds: positiveInt.default(240),
  }),
  storage: z.strictObject({
    busy_timeout_ms: positiveInt.default(5_000),
  }),
  http: z.strictObject({
    host: nonempty.default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(8787),
    max_subscriptions: positiveInt.default(1_024),
    keep_alive_ms: z.number().int().min(0).default(15_000),
  }).prefault({}),
  decision_graph: z.strictObject({
    default_review_days: positiveInt.default(30),
    retrieval_limit: z.number().int().min(1).max(100).default(20),
  }),
});

export type Config = z.infer<typeof configSchema>;
export type AdapterConfig = z.infer<typeof adapterConfigSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type ProtocolConfig = z.infer<typeof protocolConfigSchema>;
export type StageKind = z.infer<typeof stageKindSchema>;
