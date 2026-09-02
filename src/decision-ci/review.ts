import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  DecisionFinding,
  ReviewDecisionChangeInput,
  ReviewDecisionChangeOutput,
} from "../contracts/tools.js";
import { AppError, errorMessage } from "../errors.js";
import type { StorageDatabase } from "../storage/database.js";
import { canonicalJson, parseJsonValue } from "../utils/canonical-json.js";
import { deriveWorkspaceIdentity } from "../decisions/workspace.js";

const execFileAsync = promisify(execFile);

interface EvidenceChangeRow {
  decision_id: string;
  claim_id: string;
  evidence_id: string;
  claim_type: string;
  canonical_uri: string;
  locator: string | null;
  polarity: string;
  is_critical: 0 | 1;
  outcome_status: string;
}

interface RelationRow {
  id: string;
  source_decision_id: string;
  target_decision_id: string;
  relation_type: "contradicts" | "supersedes";
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

function severityValue(severity: "info" | "warning" | "error"): number {
  return severity === "error" ? 2 : severity === "warning" ? 1 : 0;
}

function thresholdValue(threshold: "none" | "warning" | "error"): number {
  return threshold === "none" ? 3 : threshold === "error" ? 2 : 1;
}

async function resolveRef(root: string, ref: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );
    return stdout.trim();
  } catch (error) {
    throw new AppError("invalid_git_ref", errorMessage(error));
  }
}

async function changedPaths(root: string, baseSha: string, headSha: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", baseSha, headSha, "--"],
    { cwd: root, encoding: "buffer", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  const fields = stdout.toString("utf8").split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    index += 1;
    if (status === undefined || status === "") {
      break;
    }
    const first = fields[index];
    index += 1;
    if (first === undefined) {
      throw new AppError("git_diff_invalid", "Git returned an incomplete name-status record");
    }
    paths.add(portable(first));
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = fields[index];
      index += 1;
      if (second === undefined) {
        throw new AppError("git_diff_invalid", "Git returned an incomplete rename record");
      }
      paths.add(portable(second));
    }
  }
  return [...paths].sort();
}

export class DecisionCiReviewer {
  readonly #db: StorageDatabase;

  constructor(db: StorageDatabase) {
    this.#db = db;
  }

  async review(input: ReviewDecisionChangeInput): Promise<ReviewDecisionChangeOutput> {
    const workspace = await deriveWorkspaceIdentity(input.working_directory);
    const [baseSha, headSha] = await Promise.all([
      resolveRef(workspace.canonicalRoot, input.base_ref),
      resolveRef(workspace.canonicalRoot, input.head_ref),
    ]);
    const paths = await changedPaths(workspace.canonicalRoot, baseSha, headSha);
    const changed = new Set(paths);
    const evidenceRows = this.#db
      .prepare<[string], EvidenceChangeRow>(`
      SELECT
        c.decision_id, c.id AS claim_id, e.id AS evidence_id, c.claim_type,
        e.canonical_uri, e.locator, ce.polarity, ce.is_critical, d.outcome_status
      FROM claim_evidence ce
      JOIN claims c ON c.id = ce.claim_id AND c.workspace_id = ce.workspace_id
      JOIN evidence e ON e.id = ce.evidence_id AND e.workspace_id = ce.workspace_id
      JOIN decisions d ON d.id = c.decision_id AND d.workspace_id = c.workspace_id
      WHERE ce.workspace_id = ? AND e.source_type = 'file'
      ORDER BY c.decision_id, c.id, e.id
    `)
      .all(workspace.id);
    const findings: DecisionFinding[] = [];
    const affectedDecisions = new Set<string>();
    for (const evidence of evidenceRows) {
      const absolute = evidence.canonical_uri.startsWith("file:")
        ? fileURLToPath(evidence.canonical_uri)
        : evidence.canonical_uri;
      const canonicalEvidencePath = await realpath(absolute).catch(() => absolute);
      const evidencePath = portable(relative(workspace.canonicalRoot, canonicalEvidencePath));
      if (!changed.has(evidencePath)) {
        continue;
      }
      affectedDecisions.add(evidence.decision_id);
      const line =
        evidence.locator === null
          ? undefined
          : Number.parseInt(evidence.locator.replace(/^L/u, ""), 10);
      findings.push({
        finding_type: "stale_evidence",
        severity: evidence.is_critical === 1 ? "error" : "warning",
        decision_id: evidence.decision_id,
        claim_id: evidence.claim_id,
        evidence_id: evidence.evidence_id,
        changed_paths: [evidencePath],
        provenance: { canonical_uri: evidence.canonical_uri, polarity: evidence.polarity },
        remediation: "Capture the file evidence again and review the linked decision.",
        ...(line === undefined || !Number.isFinite(line) ? {} : { line }),
      });
      if (evidence.claim_type === "assumption") {
        findings.push({
          finding_type: "changed_assumption",
          severity: "warning",
          decision_id: evidence.decision_id,
          claim_id: evidence.claim_id,
          evidence_id: evidence.evidence_id,
          changed_paths: [evidencePath],
          provenance: { canonical_uri: evidence.canonical_uri },
          remediation: "Review the assumption against the changed file.",
          ...(line === undefined || !Number.isFinite(line) ? {} : { line }),
        });
      }
      if (evidence.outcome_status === "disconfirmed") {
        findings.push({
          finding_type: "outcome_regression",
          severity: "error",
          decision_id: evidence.decision_id,
          claim_id: evidence.claim_id,
          evidence_id: evidence.evidence_id,
          changed_paths: [evidencePath],
          provenance: { outcome_status: evidence.outcome_status },
          remediation: "Do not repeat a decision with a disconfirmed outcome.",
          ...(line === undefined || !Number.isFinite(line) ? {} : { line }),
        });
      }
    }

    const relations = this.#db
      .prepare<[string], RelationRow>(`
      SELECT id, source_decision_id, target_decision_id, relation_type
      FROM decision_relations
      WHERE workspace_id = ? AND relation_type IN ('contradicts', 'supersedes')
      ORDER BY relation_type, source_decision_id, target_decision_id
    `)
      .all(workspace.id);
    for (const relation of relations) {
      if (
        !affectedDecisions.has(relation.source_decision_id) &&
        !affectedDecisions.has(relation.target_decision_id)
      ) {
        continue;
      }
      findings.push({
        finding_type:
          relation.relation_type === "contradicts"
            ? "conflicting_decision"
            : "superseded_precedent",
        severity: relation.relation_type === "contradicts" ? "error" : "warning",
        decision_id: relation.target_decision_id,
        changed_paths: paths,
        provenance: {
          relation_id: relation.id,
          source_decision_id: relation.source_decision_id,
          target_decision_id: relation.target_decision_id,
        },
        remediation:
          relation.relation_type === "contradicts"
            ? "Resolve the contradiction before you accept the change."
            : "Use the superseding decision as the current precedent.",
      });
    }
    findings.sort(
      (left, right) =>
        left.finding_type.localeCompare(right.finding_type) ||
        left.decision_id.localeCompare(right.decision_id) ||
        (left.claim_id ?? "").localeCompare(right.claim_id ?? ""),
    );
    const thresholdMet = findings.some(
      (finding) => severityValue(finding.severity) >= thresholdValue(input.fail_on),
    );
    const result: ReviewDecisionChangeOutput = {
      workspace_root: workspace.canonicalRoot,
      base_sha: baseSha,
      head_sha: headSha,
      findings,
      threshold_met: thresholdMet,
    };
    const reviewId = randomUUID();
    const nowMs = Date.now();
    this.#db
      .transaction(() => {
        this.#db
          .prepare(`
        INSERT INTO reviews(id, workspace_id, decision_id, base_sha, head_sha, findings_json, created_at_ms)
        SELECT ?, ?, d.id, ?, ?, ?, ? FROM decisions d
        WHERE d.workspace_id = ? ORDER BY d.created_at_ms, d.id LIMIT 1
      `)
          .run(
            reviewId,
            workspace.id,
            baseSha,
            headSha,
            canonicalJson(parseJsonValue(findings)),
            nowMs,
            workspace.id,
          );
        for (const finding of findings) {
          this.#db
            .prepare(`
          INSERT INTO ci_findings(
            id, workspace_id, review_id, decision_id, claim_id, evidence_id,
            finding_type, severity, changed_paths_json, provenance_json, remediation, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
            .run(
              randomUUID(),
              workspace.id,
              reviewId,
              finding.decision_id,
              finding.claim_id ?? null,
              finding.evidence_id ?? null,
              finding.finding_type,
              finding.severity,
              canonicalJson(parseJsonValue(finding.changed_paths)),
              canonicalJson(parseJsonValue(finding.provenance)),
              finding.remediation,
              nowMs,
            );
        }
      })
      .immediate();
    return result;
  }
}
