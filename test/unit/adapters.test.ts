import { describe, expect, it } from "vitest";
import { AdapterRegistry, validateAdapterConfigurations } from "../../src/adapters/registry.js";
import type { ProcessRunInput, ProcessRunResult } from "../../src/process/runner.js";

class CapturingRunner {
  input?: ProcessRunInput;

  run(input: ProcessRunInput): Promise<ProcessRunResult> {
    this.input = input;
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: "adapter output",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: false,
      cleanupStatus: "confirmed",
      identity: { pid: 1, startedAtMs: 1 },
    });
  }
}

const cliConfig = {
  kind: "cli" as const,
  enabled: true,
  command: "codex",
  args: ["exec", "--model", "{model}", "{prompt}"],
  timeout_seconds: 30,
  max_retries: 0,
  environment: ["ALLOWED_SECRET"],
  family: "openai",
};

describe("adapter registry", () => {
  it("owns every supported adapter descriptor and rejects unknown configuration", () => {
    expect(AdapterRegistry.names()).toEqual([
      "claude", "codex", "droid", "gemini", "llamacpp", "omp",
      "ollama", "lmstudio", "openrouter", "nebius", "openai",
    ]);
    expect(() => validateAdapterConfigurations({ unknown: cliConfig })).toThrowError(
      expect.objectContaining({ code: "unknown_adapter" }),
    );
  });

  it("gates host tools and passes only allowlisted environment variables", async () => {
    const runner = new CapturingRunner();
    const registry = new AdapterRegistry({ codex: cliConfig }, {
      processRunner: runner,
      environment: {
        PATH: "/bin",
        HOME: "/home/test",
        ALLOWED_SECRET: "allowed",
        BLOCKED_SECRET: "blocked",
        CLAUDECODE: "nested",
      },
    });
    await expect(registry.invoke({
      adapter: "codex",
      model: "sol",
      prompt: "answer",
      workingDirectory: "/tmp",
      allowHostTools: false,
    })).rejects.toMatchObject({ code: "host_tools_not_allowed" });
    expect(runner.input).toBeUndefined();

    const result = await registry.invoke({
      adapter: "codex",
      model: "sol",
      prompt: "answer",
      workingDirectory: "/tmp",
      allowHostTools: true,
    });
    expect(result).toMatchObject({ text: "adapter output", executionIsolation: "host_unrestricted" });
    expect(runner.input?.env).toEqual({
      PATH: "/bin",
      HOME: "/home/test",
      ALLOWED_SECRET: "allowed",
    });
    expect(runner.input?.args).toEqual(["exec", "--model", "sol", "answer"]);
  });

  it("maps OpenAI-compatible requests and retries only retryable failures", async () => {
    const requests: RequestInit[] = [];
    const resources: string[] = [];
    let calls = 0;
    const fetchMock: typeof fetch = (resource, init = {}) => {
      resources.push(typeof resource === "string"
        ? resource
        : resource instanceof URL
          ? resource.href
          : resource.url);
      requests.push(init);
      calls += 1;
      return Promise.resolve(calls === 1
        ? new Response("busy", { status: 503 })
        : new Response(JSON.stringify({
            id: "response-id",
            object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "remote answer" }, finish_reason: "stop" }],
          }), { status: 200, headers: { "content-type": "application/json" } }));
    };
    const registry = new AdapterRegistry({
      openai: {
        kind: "http",
        enabled: true,
        base_url: "https://example.test",
        endpoint: "/v1/chat/completions",
        api_key_env: "OPENAI_API_KEY",
        timeout_seconds: 30,
        max_retries: 1,
        family: "openai",
        headers: {},
      },
    }, {
      fetch: fetchMock,
      environment: { OPENAI_API_KEY: "secret" },
    });
    await expect(registry.invoke({
      adapter: "openai",
      model: "model-a",
      prompt: "answer",
      workingDirectory: "/tmp",
      allowHostTools: false,
    })).resolves.toMatchObject({ text: "remote answer", executionIsolation: "builtin_confined" });
    expect(calls).toBe(2);
    expect(resources).toEqual(["https://example.test/v1/chat/completions", "https://example.test/v1/chat/completions"]);
    expect(requests[0]?.headers).toMatchObject({ Authorization: "Bearer secret" });
  });

  it("preserves the OpenRouter API prefix", async () => {
    let requested = "";
    const registry = new AdapterRegistry({
      openrouter: {
        kind: "http",
        enabled: true,
        base_url: "https://openrouter.ai/api",
        endpoint: "/api/v1/chat/completions",
        api_key_env: "OPENROUTER_API_KEY",
        timeout_seconds: 30,
        max_retries: 0,
        family: "openrouter",
        headers: {},
      },
    }, {
      environment: { OPENROUTER_API_KEY: "secret" },
      fetch: (resource) => {
        requested = typeof resource === "string"
          ? resource
          : resource instanceof URL
            ? resource.href
            : resource.url;
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: "answer" } }],
        }), { status: 200 }));
      },
    });
    await registry.invoke({
      adapter: "openrouter",
      model: "model-a",
      prompt: "answer",
      workingDirectory: "/tmp",
      allowHostTools: false,
    });
    expect(requested).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});
