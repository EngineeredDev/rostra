import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { configSchema } from "../../src/config/schema.js";
import { afterEach, describe, expect, it } from "vitest";
import { reviewDecisionChangeInputSchema, reviewDecisionChangeOutputSchema } from "../../src/contracts/tools.js";
import { DecisionCiReviewer } from "../../src/decision-ci/review.js";
import { DecisionRepository } from "../../src/decisions/repository.js";
import { deriveWorkspaceIdentity } from "../../src/decisions/workspace.js";
import { JobStore } from "../../src/jobs/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { openStorage } from "../../src/storage/database.js";
import { sha256File } from "../../src/utils/hash-file.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local Decision CI", () => {
  it("reports changed critical evidence with deterministic threshold behavior", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-counsel-ci-"));
    roots.push(root);
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "ci@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "CI"], { cwd: root });
    const evidencePath = join(root, "decision.txt");
    await writeFile(evidencePath, "original\n");
    await execFileAsync("git", ["add", "decision.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });
    const { stdout: baseStdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    const base = baseStdout.trim();

    const db = await openStorage(join(root, "ai-counsel.sqlite"));
    const workspace = await deriveWorkspaceIdentity(root);
    const decisionId = "11111111-1111-4111-8111-111111111111";
    const claimId = "22222222-2222-4222-8222-222222222222";
    const evidenceId = "33333333-3333-4333-8333-333333333333";
    const now = Date.now();
    db.prepare("INSERT INTO workspaces(id, canonical_root, created_at_ms) VALUES (?, ?, ?)")
      .run(workspace.id, workspace.canonicalRoot, now);
    db.prepare(`
      INSERT INTO decisions(
        id, workspace_id, question, protocol, result_status, outcome_status,
        canonical_json, summary, execution_isolation, review_due_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'Use evidence', 'quick', 'partial', 'plurality', '{}', 'summary',
        'builtin_confined', ?, ?, ?)
    `).run(decisionId, workspace.id, now + 100_000, now, now);
    db.prepare(`
      INSERT INTO claims(id, workspace_id, decision_id, claim_type, text, confidence, created_at_ms)
      VALUES (?, ?, ?, 'assumption', 'The file stays stable', 1, ?)
    `).run(claimId, workspace.id, decisionId, now);
    db.prepare(`
      INSERT INTO evidence(
        id, workspace_id, decision_id, source_type, canonical_uri, locator, content_hash,
        captured_at_ms, tool_or_adapter, execution_isolation, redaction_status
      ) VALUES (?, ?, ?, 'file', ?, 'L1', ?, ?, 'read_file', 'builtin_confined', 'none')
    `).run(
      evidenceId,
      workspace.id,
      decisionId,
      evidencePath,
      await sha256File(evidencePath),
      now,
    );
    db.prepare(`
      INSERT INTO claim_evidence(workspace_id, claim_id, evidence_id, polarity, is_critical)
      VALUES (?, ?, ?, 'supports', 1)
    `).run(workspace.id, claimId, evidenceId);

    await writeFile(evidencePath, "changed\n");
    await execFileAsync("git", ["add", "decision.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "head"], { cwd: root });
    const { stdout: headStdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    const head = headStdout.trim();
    const reviewer = new DecisionCiReviewer(db);
    const result = await reviewer.review(reviewDecisionChangeInputSchema.parse({
      working_directory: root,
      base_ref: base,
      head_ref: head,
      fail_on: "warning",
    }));
    expect(result).toMatchObject({
      workspace_root: workspace.canonicalRoot,
      base_sha: base,
      head_sha: head,
      threshold_met: true,
    });
    expect(result.findings.map((finding) => finding.finding_type)).toEqual([
      "changed_assumption",
      "stale_evidence",
    ]);
    expect(result.findings[1]).toMatchObject({
      severity: "error",
      changed_paths: ["decision.txt"],
      line: 1,
    });
    const mcpConfig = configSchema.parse({
      version: 2,
      adapters: {},
      model_registry: { models: [] },
      defaults: { protocol: "quick" },
      protocols: {},
      similarity: { provider: "local_minilm" },
      execution: { allow_host_tools: false },
      jobs: {},
      storage: {},
      decision_graph: {},
    });
    const mcpServer = createMcpServer({
      config: mcpConfig,
      store: new JobStore(db, { dedupeSuccessMs: 1_000, leaseMs: 1_000 }),
      decisions: new DecisionRepository(db),
      reviewer,
      ensureSupervisor: () => Promise.resolve(),
    });
    const mcpClient = new Client({ name: "decision-ci-test", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);
    const mcpReview = reviewDecisionChangeOutputSchema.parse((await mcpClient.callTool({
      name: "review_decision_change",
      arguments: {
        working_directory: root,
        base_ref: base,
        head_ref: head,
        fail_on: "warning",
      },
    })).structuredContent);
    expect(mcpReview).toEqual(result);
    await Promise.all([mcpClient.close(), mcpServer.close()]);
    const configPath = join(root, "config.yaml");
    await writeFile(configPath, [
      "version: 2",
      "adapters: {}",
      "model_registry: { models: [] }",
      "defaults: { protocol: quick }",
      "protocols: {}",
      "similarity: { provider: local_minilm }",
      "execution: { allow_host_tools: false }",
      "jobs: {}",
      "storage: {}",
      "decision_graph: {}",
      "",
    ].join("\n"));
    const environment = {
      ...process.env,
      AI_COUNSEL_CONFIG: configPath,
      AI_COUNSEL_DATA_HOME: root,
    };
    const cli = spawnSync(process.execPath, [
      resolve("dist/cli/main.js"),
      "decision", "review",
      "--working-directory", root,
      "--base", base,
      "--head", head,
      "--format", "json",
      "--fail-on", "warning",
    ], { cwd: process.cwd(), env: environment, encoding: "utf8" });
    expect(cli.status, cli.stderr).toBe(2);
    expect(reviewDecisionChangeOutputSchema.parse(JSON.parse(cli.stdout)).findings).toEqual(
      result.findings,
    );
    const malformed = spawnSync(process.execPath, [
      resolve("dist/cli/main.js"),
      "decision", "review",
      "--working-directory", root,
      "--base", "missing-ref",
      "--head", head,
    ], { cwd: process.cwd(), env: environment, encoding: "utf8" });
    expect(malformed.status).toBe(1);
    db.close();
  });
});
