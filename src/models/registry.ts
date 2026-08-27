import type { AdapterRegistry } from "../adapters/registry.js";
import type { Config, ModelConfig } from "../config/schema.js";
import type { Participant } from "../contracts/common.js";
import { AppError } from "../errors.js";

export class ModelRegistry {
  readonly #models: readonly ModelConfig[];
  readonly #adapters: AdapterRegistry;
  readonly #byKey = new Map<string, ModelConfig>();
  readonly #sessionOverrides = new Map<string, string>();

  constructor(config: Config, adapters: AdapterRegistry) {
    this.#models = config.model_registry.models;
    this.#adapters = adapters;
    for (const model of this.#models) {
      const adapter = adapters.configuration(model.adapter);
      const descriptor = adapters.descriptor(model.adapter);
      if (adapter.kind !== descriptor.transport) {
        throw new AppError("invalid_model_registry", `Adapter mismatch for ${model.adapter}`);
      }
      const key = this.#key(model.adapter, model.id);
      if (this.#byKey.has(key)) {
        throw new AppError("duplicate_model", `Duplicate model ${model.id} for ${model.adapter}`);
      }
      this.#byKey.set(key, model);
    }
  }

  #key(adapter: string, model: string): string {
    return `${adapter}\0${model}`;
  }

  list(adapter?: string): ModelConfig[] {
    return this.#models.filter(
      (model) => model.enabled && (adapter === undefined || model.adapter === adapter),
    );
  }

  resolve(adapter: string, requestedModel?: string): ModelConfig {
    this.#adapters.configuration(adapter);
    const selected = requestedModel ?? this.#sessionOverrides.get(adapter);
    if (selected !== undefined) {
      const model = this.#byKey.get(this.#key(adapter, selected));
      if (model === undefined) {
        throw new AppError("model_not_allowed", `${selected} is not configured for ${adapter}`);
      }
      if (!model.enabled) {
        throw new AppError("model_disabled", `${selected} is disabled for ${adapter}`);
      }
      return model;
    }
    const configuredDefault = this.#models.find(
      (model) => model.adapter === adapter && model.enabled && model.default,
    );
    const firstEnabled = this.#models.find(
      (model) => model.adapter === adapter && model.enabled,
    );
    const model = configuredDefault ?? firstEnabled;
    if (model === undefined) {
      throw new AppError("model_not_allowed", `No enabled model is configured for ${adapter}`);
    }
    return model;
  }

  validateParticipant(participant: Participant): ModelConfig {
    const model = this.resolve(participant.cli, participant.model);
    if (participant.reasoning_effort !== undefined) {
      const descriptor = this.#adapters.descriptor(participant.cli);
      if (
        !model.reasoning_efforts.includes(participant.reasoning_effort) ||
        !descriptor.supportedReasoningEfforts.includes(participant.reasoning_effort)
      ) {
        throw new AppError(
          "reasoning_effort_not_supported",
          `${participant.reasoning_effort} is not supported by ${participant.cli}/${participant.model}`,
        );
      }
    }
    return model;
  }

  capabilities(adapter: string, modelId: string): string[] {
    const model = this.resolve(adapter, modelId);
    const descriptor = this.#adapters.descriptor(adapter);
    return model.capabilities.filter((capability) => descriptor.capabilities.includes(capability));
  }

  setSessionOverride(adapter: string, modelId: string | null): void {
    if (modelId === null) {
      this.#sessionOverrides.delete(adapter);
      return;
    }
    this.resolve(adapter, modelId);
    this.#sessionOverrides.set(adapter, modelId);
  }

  sessionOverrides(): Record<string, string> {
    return Object.fromEntries(this.#sessionOverrides);
  }
}
