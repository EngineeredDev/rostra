import { pathToFileURL } from "node:url";
import type { ReviewDecisionChangeOutput } from "../contracts/tools.js";
import type { JsonValue } from "../utils/canonical-json.js";

const ruleIds = [
  "stale_evidence",
  "changed_assumption",
  "conflicting_decision",
  "superseded_precedent",
  "outcome_regression",
] as const;

export function renderSarif(review: ReviewDecisionChangeOutput, packageVersion: string): JsonValue {
  const rootUrl = pathToFileURL(
    review.workspace_root.endsWith("/") ? review.workspace_root : `${review.workspace_root}/`,
  ).href;
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "rostra-decision-ci",
            version: packageVersion,
            rules: ruleIds.map((id) => ({
              id,
              name: id,
              shortDescription: { text: id.replaceAll("_", " ") },
            })),
          },
        },
        originalUriBaseIds: {
          "%SRCROOT%": { uri: rootUrl },
        },
        results: review.findings.map((finding) => ({
          ruleId: finding.finding_type,
          level: finding.severity === "info" ? "note" : finding.severity,
          message: { text: finding.remediation },
          locations:
            finding.changed_paths.length === 0
              ? []
              : [
                  {
                    physicalLocation: {
                      artifactLocation: {
                        uri: finding.changed_paths[0] ?? "",
                        uriBaseId: "%SRCROOT%",
                      },
                      ...(finding.line === undefined
                        ? {}
                        : { region: { startLine: finding.line } }),
                    },
                  },
                ],
          properties: {
            decision_id: finding.decision_id,
            ...(finding.claim_id === undefined ? {} : { claim_id: finding.claim_id }),
            ...(finding.evidence_id === undefined ? {} : { evidence_id: finding.evidence_id }),
            remediation: finding.remediation,
            provenance: finding.provenance,
          },
        })),
      },
    ],
  };
}
