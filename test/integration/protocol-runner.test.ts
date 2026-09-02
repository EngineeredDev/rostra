import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { decisionPacketSchema, deliberationResultSchema } from "../../src/contracts/results.js";
import { DecisionCiReviewer } from "../../src/decision-ci/review.js";
import { DecisionRepository } from "../../src/decisions/repository.js";
import { ConfiguredProtocolRunner } from "../../src/deliberation/runner.js";
import { RunContext } from "../../src/jobs/run-context.js";
import { JobStore } from "../../src/jobs/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { reconcileMissingTranscripts } from "../../src/transcript/reconcile.js";
import { openStorage } from "../../src/storage/database.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const requestBodySchema = z.strictObject({
  model: z.string(),
  messages: z.array(z.strictObject({ role: z.string(), content: z.string() })),
});

describe("configured protocol runner", () => {
  it("runs participant stages concurrently and publishes a typed packet", async () => {
    const root = await mkdtemp(join(tmpdir(), "rostra-runner-"));
    roots.push(root);
    const databasePath = join(root, "rostra.sqlite");
    await writeFile(join(root, "evidence.txt"), "verified evidence\n");
    const config = configSchema.parse({
      version: 2,
      adapters: {
        openai: {
          kind: "http",
          base_url: "https://models.test",
          api_key_env: "OPENAI_API_KEY",
          family: "openai",
        },
      },
      model_registry: {
        models: [
          {
            id: "model-a",
            adapter: "openai",
            capabilities: ["analysis"],
            provider_family: "openai",
          },
          {
            id: "model-b",
            adapter: "openai",
            capabilities: ["analysis"],
            provider_family: "openai",
          },
          {
            id: "model-c",
            adapter: "openai",
            capabilities: ["analysis"],
            provider_family: "openai",
          },
        ],
      },
      defaults: { protocol: "quick" },
      protocols: {
        quick: {
          stages: [
            { id: "analysis", kind: "independent_analysis", minimum_completions: 2 },
            {
              id: "evidence",
              kind: "evidence_collection",
              allowed_capabilities: ["read_file"],
              minimum_completions: 2,
            },
            {
              id: "ballot",
              kind: "final_ballot",
              minimum_completions: 2,
              visibility: "full_prior",
              stopping_policy: "qualified_decision",
            },
            { id: "unreachable", kind: "experiment_proposal", minimum_completions: 2 },
          ],
        },
      },
      similarity: {
        provider: "openai_compatible",
        base_url: "https://embeddings.test",
        model: "embed-a",
        api_key_env: "EMBED_KEY",
        agreement_threshold: 0.8,
        retrieval_threshold: 0.7,
        thresholds_revision: "test",
      },
      execution: { allow_host_tools: false },
      jobs: {},
      storage: {},
      decision_graph: { default_review_days: 1 },
    });
    const db = await openStorage(databasePath);
    const store = new JobStore(db, { dedupeSuccessMs: 1_000, leaseMs: 5_000 });
    const mcpServer = createMcpServer({
      config,
      store,
      decisions: new DecisionRepository(db),
      reviewer: new DecisionCiReviewer(db),
      sessionModels: new Map<string, string>(),
      ensureSupervisor: () => Promise.resolve(),
    });
    const mcpClient = new Client({ name: "runner-integration", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);
    await mcpClient.callTool({
      name: "set_session_models",
      arguments: { models: { openai: "model-b" } },
    });
    const started = z.object({ job_id: z.uuid() }).parse(
      (
        await mcpClient.callTool({
          name: "start_deliberation",
          arguments: {
            question: "Choose an option",
            working_directory: root,
            protocol: "quick",
            committee: { mode: "adaptive", size: 2, min_provider_families: 1 },
            allow_unknown_cost: true,
            decision_options: [
              { id: "option-a", label: "Option A" },
              { id: "option-b", label: "Option B" },
            ],
          },
        })
      ).structuredContent,
    );
    const submitted = store.get(started.job_id);
    expect(submitted.request.session_models).toEqual({ openai: "model-b" });
    await Promise.all([mcpClient.close(), mcpServer.close()]);
    const claimed = store.claimNext("build", "config");
    if (claimed === undefined) throw new Error("Expected a claimed job");
    const running = store.handshakeWorker(
      claimed.job_id,
      claimed.dispatch_token,
      claimed.row_version,
    );
    const claimIds: Record<string, string> = {
      "model-a": "11111111-1111-4111-8111-111111111111",
      "model-b": "22222222-2222-4222-8222-222222222222",
    };
    let finalBallotPrompt = "";
    let modelCalls = 0;
    let embeddingCalls = 0;
    const fetchMock: typeof fetch = (resource, init = {}) => {
      const url =
        resource instanceof URL
          ? resource.href
          : typeof resource === "string"
            ? resource
            : resource.url;
      if (url.includes("embeddings.test")) {
        embeddingCalls += 1;
        const body = z
          .object({ input: z.array(z.string()) })
          .parse(JSON.parse(typeof init.body === "string" ? init.body : "{}"));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: body.input.map((text, index) => ({
                index,
                embedding: text.includes("model-b") || text === "option-b" ? [0, 1] : [1, 0],
              })),
            }),
            { status: 200 },
          ),
        );
      }
      modelCalls += 1;
      const body = requestBodySchema.parse(
        JSON.parse(typeof init.body === "string" ? init.body : "{}"),
      );
      const prompt = body.messages[0]?.content ?? "";
      const claimId = claimIds[body.model];
      if (claimId === undefined) throw new Error(`Unexpected model: ${body.model}`);
      let content: string;
      if (prompt.includes("final_ballot")) {
        finalBallotPrompt = prompt;
        content = `Ballot\nROSTRA_RESULT: {"option_id":"option-a","confidence":0.9,"rationale":"${body.model}","continue_debate":false}`;
      } else if (prompt.includes("evidence_collection")) {
        const evidenceId = /"evidence_id":"([^"]+)"/u.exec(prompt)?.[1];
        content =
          evidenceId === undefined
            ? `ROSTRA_TOOL_REQUEST: {"name":"read_file","arguments":{"path":"evidence.txt"},"claim_id":"${claimId}","polarity":"supports"}`
            : `Evidence verified\nROSTRA_RESULT: {"claim_id":"${claimId}","evidence_requests":["read evidence.txt"],"evidence_ids":["${evidenceId}"],"assessment":"verified evidence"}`;
      } else {
        const recommendation = body.model === "model-a" ? "option-a" : "option-b";
        content = `Analysis\nROSTRA_RESULT: {"claims":[{"claim_id":"${claimId}","type":"fact","text":"verified ${body.model}","confidence":0.9}],"assumptions":["bounded"],"recommendation":"${recommendation}","confidence":0.9,"predictions":[]}`;
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content } }],
          }),
          { status: 200 },
        ),
      );
    };
    const runner = new ConfiguredProtocolRunner({
      config,
      databasePath,
      adapterOptions: {
        fetch: fetchMock,
        environment: { OPENAI_API_KEY: "model-secret", EMBED_KEY: "embed-secret" },
      },
    });
    const execution = await runner.execute(running, new RunContext(running.job_id));
    expect(execution.status).toBe("complete");
    const result = deliberationResultSchema.parse(execution.result);
    expect(result.decision.ballot).toMatchObject({
      outcome: "unanimous",
      consensus_reached: true,
      final_tally: { "option-a": 2 },
    });
    expect(result.decision.convergence).toMatchObject({
      cross_model_agreement: 0,
      impasse: false,
      progress: { checks: 3 },
    });
    expect(embeddingCalls).toBe(3);
    expect(result.decision.participants.map((participant) => participant.model)).toEqual([
      "model-b",
      "model-a",
    ]);
    expect(result.decision.committee_selection[0]?.selection_reason).toBe("session_default");
    expect(result.execution_isolation).toBe("builtin_confined");
    expect(finalBallotPrompt).toContain("- option-a: Option A");
    expect(finalBallotPrompt).toContain("- option-b: Option B");
    expect(finalBallotPrompt).toContain("Participant adaptive_1:");
    expect(store.attempts(submitted.job_id)).toHaveLength(8);
    expect(
      z.object({ next_stage: z.number() }).parse(store.latestCheckpoint(submitted.job_id))
        .next_stage,
    ).toBe(4);
    expect(result.decision.evidence).toHaveLength(2);
    expect(result.decision.evidence.map((evidence) => evidence.locator)).toEqual([
      "evidence.txt",
      "evidence.txt",
    ]);
    expect(
      result.decision.evidence
        .map((evidence) => evidence.claim_id)
        .filter((claimId): claimId is string => claimId !== undefined)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(Object.values(claimIds).sort((left, right) => left.localeCompare(right)));
    for (let index = 0; index < 20; index += 1) {
      store.recordQuality({
        adapter: "openai",
        model: "model-c",
        domain: "general",
        valid_attempt: true,
        latencyMs: 1,
      });
    }
    const replay = await runner.execute(running, new RunContext(running.job_id));
    const replayResult = deliberationResultSchema.parse(replay.result);
    expect(replayResult.decision.participants).toEqual(result.decision.participants);
    expect(replayResult.decision.committee_selection).toEqual(result.decision.committee_selection);
    expect(store.attempts(submitted.job_id)).toHaveLength(8);
    expect(modelCalls).toBe(8);
    if (replay.publication === undefined) throw new Error("Expected publication");
    const publication = replay.publication;
    const current = store.get(submitted.job_id);
    if (current.lease_token === undefined) throw new Error("Expected lease");
    const leaseToken = current.lease_token;
    const invalidPacket = decisionPacketSchema.parse({
      ...publication.packet,
      evidence: [
        {
          evidence_id: "33333333-3333-4333-8333-333333333333",
          claim_id: "44444444-4444-4444-8444-444444444444",
          source_type: "file",
          canonical_uri: "missing.txt",
          content_hash: "deadbeef",
          captured_at_ms: 1,
          tool_or_adapter: "read_file",
          execution_isolation: "builtin_confined",
          redaction_status: "none",
          polarity: "supports",
        },
      ],
    });
    expect(() =>
      store.commitDecisionResult({
        jobId: current.job_id,
        expectedVersion: current.row_version,
        leaseToken,
        workspaceId: publication.workspaceId,
        canonicalRoot: publication.canonicalRoot,
        requestFingerprint: publication.requestFingerprint,
        packet: invalidPacket,
        summary: publication.summary,
        resultStatus: replay.status,
        resultJson: replay.result,
        transcriptPath: publication.transcriptPath,
      }),
    ).toThrow();
    expect(store.get(current.job_id).status).toBe("running");
    const committed = store.commitDecisionResult({
      jobId: current.job_id,
      expectedVersion: current.row_version,
      leaseToken,
      workspaceId: publication.workspaceId,
      canonicalRoot: publication.canonicalRoot,
      requestFingerprint: publication.requestFingerprint,
      packet: publication.packet,
      summary: publication.summary,
      resultStatus: replay.status,
      resultJson: replay.result,
      transcriptPath: publication.transcriptPath,
    });
    await rename(publication.temporaryTranscriptPath, publication.transcriptPath);
    expect(committed).toMatchObject({
      status: "succeeded",
      decision_id: replayResult.decision.decision_id,
    });
    expect(db.prepare("SELECT count(*) AS count FROM evidence").get()).toEqual({ count: 2 });
    expect(await readFile(replayResult.transcript_path, "utf8")).toContain(
      replayResult.decision.decision_id,
    );
    await rm(replayResult.transcript_path);
    expect(await reconcileMissingTranscripts(db)).toBe(1);
    expect(await readFile(replayResult.transcript_path, "utf8")).toContain(
      "Authoritative Final Projection",
    );
    store.close();
  });
});
