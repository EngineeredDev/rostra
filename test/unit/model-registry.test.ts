import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { configSchema } from "../../src/config/schema.js";
import { ModelRegistry } from "../../src/models/registry.js";

const config = configSchema.parse({
  version: 2,
  adapters: {
    codex: { kind: "cli", command: "codex", family: "openai" },
  },
  model_registry: {
    models: [
      {
        id: "sol",
        adapter: "codex",
        default: true,
        reasoning_efforts: ["medium", "high"],
        capabilities: ["analysis", "code"],
        provider_family: "openai",
      },
      {
        id: "disabled",
        adapter: "codex",
        enabled: false,
        capabilities: ["analysis"],
        provider_family: "openai",
      },
    ],
  },
  defaults: { protocol: "quick" },
  protocols: {},
  similarity: { provider: "local_minilm" },
  execution: { allow_host_tools: false },
  jobs: {},
  storage: {},
  decision_graph: {},
});

describe("model registry", () => {
  it("derives defaults, capabilities, and validation from descriptors", () => {
    const adapters = new AdapterRegistry(config.adapters);
    const models = new ModelRegistry(config, adapters);
    expect(models.resolve("codex")).toMatchObject({ id: "sol", adapter: "codex" });
    expect(models.capabilities("codex", "sol")).toEqual(["analysis", "code"]);
    expect(() => models.validateParticipant({
      participant_id: "reviewer",
      cli: "codex",
      model: "sol",
      reasoning_effort: "xhigh",
    })).toThrowError(expect.objectContaining({ code: "reasoning_effort_not_supported" }));
    expect(() => models.resolve("codex", "disabled")).toThrowError(
      expect.objectContaining({ code: "model_disabled" }),
    );
  });

  it("applies and clears validated session overrides", () => {
    const models = new ModelRegistry(config, new AdapterRegistry(config.adapters));
    models.setSessionOverride("codex", "sol");
    expect(models.sessionOverrides()).toEqual({ codex: "sol" });
    models.setSessionOverride("codex", null);
    expect(models.sessionOverrides()).toEqual({});
  });
});
