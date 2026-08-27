import { z } from "zod/v4";
import {
  cliAdapterConfigSchema,
  httpAdapterConfigSchema,
  type AdapterConfig,
} from "../config/schema.js";
import type { ExecutionIsolation } from "../contracts/common.js";
import { AppError, errorMessage } from "../errors.js";
import { ProcessRunner, type ProcessRunInput, type ProcessRunResult } from "../process/runner.js";
import { readBoundedResponseText } from "../utils/http.js";

interface ProcessRunnerPort {
  run(input: ProcessRunInput): Promise<ProcessRunResult>;
}
export interface AdapterDescriptor {
  name: string;
  transport: "cli" | "http";
  providerFamily: string;
  supportedReasoningEfforts: readonly string[];
  capabilities: readonly string[];
  environmentAllowlist: readonly string[];
  configSchema: z.ZodType<AdapterConfig>;
  httpStyle?: "ollama" | "openai";
}

const commonCliEnvironment = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "USERPROFILE",
  "SystemRoot",
] as const;

const descriptorList: readonly AdapterDescriptor[] = [
  { name: "claude", transport: "cli", providerFamily: "anthropic", supportedReasoningEfforts: ["low", "medium", "high"], capabilities: ["analysis", "code", "evidence"], environmentAllowlist: commonCliEnvironment, configSchema: cliAdapterConfigSchema },
  { name: "codex", transport: "cli", providerFamily: "openai", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], capabilities: ["analysis", "code", "evidence"], environmentAllowlist: commonCliEnvironment, configSchema: cliAdapterConfigSchema },
  { name: "droid", transport: "cli", providerFamily: "factory", supportedReasoningEfforts: ["off", "none", "low", "medium", "high"], capabilities: ["analysis", "code", "evidence"], environmentAllowlist: commonCliEnvironment, configSchema: cliAdapterConfigSchema },
  { name: "gemini", transport: "cli", providerFamily: "google", supportedReasoningEfforts: [], capabilities: ["analysis", "code", "evidence"], environmentAllowlist: commonCliEnvironment, configSchema: cliAdapterConfigSchema },
  { name: "llamacpp", transport: "cli", providerFamily: "local", supportedReasoningEfforts: [], capabilities: ["analysis"], environmentAllowlist: commonCliEnvironment, configSchema: cliAdapterConfigSchema },
  { name: "omp", transport: "cli", providerFamily: "omp", supportedReasoningEfforts: ["off", "minimal", "low", "medium", "high"], capabilities: ["analysis", "code", "evidence"], environmentAllowlist: commonCliEnvironment, configSchema: cliAdapterConfigSchema },
  { name: "ollama", transport: "http", providerFamily: "local", supportedReasoningEfforts: [], capabilities: ["analysis"], environmentAllowlist: [], configSchema: httpAdapterConfigSchema, httpStyle: "ollama" },
  { name: "lmstudio", transport: "http", providerFamily: "local", supportedReasoningEfforts: [], capabilities: ["analysis"], environmentAllowlist: [], configSchema: httpAdapterConfigSchema, httpStyle: "openai" },
  { name: "openrouter", transport: "http", providerFamily: "openrouter", supportedReasoningEfforts: [], capabilities: ["analysis"], environmentAllowlist: [], configSchema: httpAdapterConfigSchema, httpStyle: "openai" },
  { name: "nebius", transport: "http", providerFamily: "nebius", supportedReasoningEfforts: [], capabilities: ["analysis"], environmentAllowlist: [], configSchema: httpAdapterConfigSchema, httpStyle: "openai" },
  { name: "openai", transport: "http", providerFamily: "openai", supportedReasoningEfforts: ["low", "medium", "high"], capabilities: ["analysis"], environmentAllowlist: [], configSchema: httpAdapterConfigSchema, httpStyle: "openai" },
];

const descriptors: Record<string, AdapterDescriptor> = Object.fromEntries(
  descriptorList.map((descriptor) => [descriptor.name, descriptor]),
);
const nestedSessionMarkers: Record<string, true> = {
  CLAUDECODE: true,
  CLAUDE_CODE_ENTRYPOINT: true,
  CODEX_THREAD_ID: true,
};

export interface AdapterInvocation {
  adapter: string;
  model: string;
  prompt: string;
  workingDirectory: string;
  reasoningEffort?: string;
  allowHostTools: boolean;
  signal?: AbortSignal;
}

export interface AdapterResult {
  text: string;
  executionIsolation: ExecutionIsolation;
  cleanupStatus: "confirmed" | "uncertain";
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface RegistryOptions {
  processRunner?: ProcessRunnerPort;
  fetch?: typeof fetch;
  environment?: Readonly<Record<string, string | undefined>>;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxResponseBytes?: number;
  terminationGraceMs?: number;
}

export function validateAdapterConfigurations(
  configurations: Readonly<Record<string, unknown>>,
): Record<string, AdapterConfig> {
  const validated: Record<string, AdapterConfig> = {};
  for (const [name, value] of Object.entries(configurations)) {
    const descriptor = descriptors[name];
    if (descriptor === undefined) {
      throw new AppError("unknown_adapter", `Unknown adapter: ${name}`);
    }
    const config = descriptor.configSchema.parse(value);
    if (config.kind !== descriptor.transport) {
      throw new AppError(
        "invalid_adapter_config",
        `${name} requires ${descriptor.transport} configuration`,
      );
    }
    validated[name] = config;
  }
  return validated;
}


export class AdapterRegistry {
  readonly #configurations: Record<string, AdapterConfig>;
  readonly #runner: ProcessRunnerPort;
  readonly #fetch: typeof fetch;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #maxStdoutBytes: number;
  readonly #maxStderrBytes: number;
  readonly #maxResponseBytes: number;
  readonly #terminationGraceMs: number;

  constructor(configurations: Readonly<Record<string, unknown>>, options: RegistryOptions = {}) {
    this.#configurations = validateAdapterConfigurations(configurations);
    this.#runner = options.processRunner ?? new ProcessRunner();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#environment = options.environment ?? process.env;
    this.#maxStdoutBytes = options.maxStdoutBytes ?? 1_048_576;
    this.#maxStderrBytes = options.maxStderrBytes ?? 262_144;
    this.#maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    this.#terminationGraceMs = options.terminationGraceMs ?? 5_000;
  }

  static names(): string[] {
    return descriptorList.map((descriptor) => descriptor.name);
  }

  descriptor(name: string): AdapterDescriptor {
    const descriptor = descriptors[name];
    if (descriptor === undefined) {
      throw new AppError("unknown_adapter", `Unknown adapter: ${name}`);
    }
    return descriptor;
  }

  async invoke(input: AdapterInvocation): Promise<AdapterResult> {
    const descriptor = this.descriptor(input.adapter);
    const configuration = this.#configurations[input.adapter];
    if (configuration === undefined || !configuration.enabled) {
      throw new AppError("adapter_disabled", `Adapter ${input.adapter} is not enabled`);
    }
    if (configuration.kind === "cli") {
      if (!input.allowHostTools) {
        throw new AppError(
          "host_tools_not_allowed",
          `CLI adapter ${input.adapter} requires execution.allow_host_tools: true`,
        );
      }
      return this.#invokeCli(descriptor, configuration, input);
    }
    return this.#invokeHttp(descriptor, configuration, input);
  }

  configuration(name: string): AdapterConfig {
    const configuration = this.#configurations[name];
    if (configuration === undefined || !configuration.enabled) {
      throw new AppError("adapter_disabled", `Adapter ${name} is not enabled`);
    }
    return configuration;
  }

  async #invokeCli(
    descriptor: AdapterDescriptor,
    configuration: z.infer<typeof cliAdapterConfigSchema>,

    input: AdapterInvocation,
  ): Promise<AdapterResult> {
    const allowed = [...descriptor.environmentAllowlist, ...configuration.environment];
    const environment: Record<string, string> = {};
    for (const name of allowed) {
      if (nestedSessionMarkers[name] === true) {
        continue;
      }
      const value = this.#environment[name];
      if (value !== undefined) {
        environment[name] = value;
      }
    }
    const substitutions: Record<string, string> = {
      "{model}": input.model,
      "{prompt}": input.prompt,
      "{reasoning_effort}": input.reasoningEffort ?? "medium",
      "{working_directory}": input.workingDirectory,
    };
    const args = configuration.args.map((argument) => {
      let value = argument;
      for (const [placeholder, replacement] of Object.entries(substitutions)) {
        value = value.replaceAll(placeholder, replacement);
      }
      return value;
    });
    const result = await this.#runner.run({
      command: configuration.command,
      args,
      cwd: input.workingDirectory,
      env: environment,
      timeoutMs: configuration.timeout_seconds * 1_000,
      maxStdoutBytes: this.#maxStdoutBytes,
      maxStderrBytes: this.#maxStderrBytes,
      terminationGraceMs: this.#terminationGraceMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.exitCode !== 0) {
      const type = result.timedOut
        ? "adapter_timeout"
        : result.cancelled
          ? "adapter_cancelled"
          : "adapter_process_failed";
      throw new AppError(type, `${input.adapter} exited with code ${String(result.exitCode)}`);
    }
    return {
      text: result.stdout.trim(),
      executionIsolation: "host_unrestricted",
      cleanupStatus: result.cleanupStatus,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    };
  }

  async #invokeHttp(
    descriptor: AdapterDescriptor,
    configuration: z.infer<typeof httpAdapterConfigSchema>,
    input: AdapterInvocation,
  ): Promise<AdapterResult> {
    const endpoint = new URL(configuration.endpoint, configuration.base_url).href;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...configuration.headers,
    };
    if (configuration.api_key_env !== undefined) {
      const secret = this.#environment[configuration.api_key_env];
      if (secret === undefined || secret === "") {
        throw new AppError("adapter_auth_unavailable", `Missing ${configuration.api_key_env}`);
      }
      headers.Authorization = `Bearer ${secret}`;
    }
    const body = descriptor.httpStyle === "ollama"
      ? { model: input.model, prompt: input.prompt, stream: false }
      : { model: input.model, messages: [{ role: "user", content: input.prompt }] };
    let lastError: unknown;
    for (let attempt = 0; attempt <= configuration.max_retries; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(configuration.timeout_seconds * 1_000);
      const signal = input.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([input.signal, timeoutSignal]);
      try {
        const response = await this.#fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < configuration.max_retries) {
            continue;
          }
          throw new AppError("adapter_http_error", `${input.adapter} HTTP ${response.status}`);
        }
        const raw = await readBoundedResponseText(response, this.#maxResponseBytes);
        let text: string;
        try {
          const value: unknown = JSON.parse(raw);
          const parsed = descriptor.httpStyle === "ollama"
            ? z.object({ response: z.string() }).parse(value).response
            : z.object({
                choices: z.array(z.object({
                  message: z.object({ content: z.string() }),
                })).min(1),
              }).parse(value).choices[0]?.message.content;
          if (parsed === undefined) {
            throw new Error("missing content");
          }
          text = parsed;
        } catch {
          throw new AppError("adapter_response_invalid", `${input.adapter} returned invalid content`);
        }
        return {
          text,
          executionIsolation: "builtin_confined",
          cleanupStatus: "confirmed",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      } catch (error) {
        lastError = error;
        if (input.signal?.aborted === true) {
          throw new AppError("adapter_cancelled", `${input.adapter} was cancelled`);
        }
        const retryable = !(error instanceof AppError);
        if (!retryable || attempt >= configuration.max_retries) {
          break;
        }
      }
    }
    if (lastError instanceof AppError) {
      throw lastError;
    }
    throw new AppError("adapter_network_error", errorMessage(lastError));
  }
}
