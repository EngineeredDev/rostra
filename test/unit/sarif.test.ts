import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Ajv } from "ajv/dist/ajv.js";
import { z } from "zod/v4";
import { describe, expect, it } from "vitest";
import { renderSarif } from "../../src/decision-ci/sarif.js";
import { PACKAGE_VERSION } from "../../src/version.js";
import { reviewDecisionChangeOutputSchema } from "../../src/contracts/tools.js";

const review = reviewDecisionChangeOutputSchema.parse({
  workspace_root: "/workspace",
  base_sha: "a",
  head_sha: "b",
  threshold_met: true,
  findings: [
    {
      finding_type: "stale_evidence",
      severity: "error",
      decision_id: "11111111-1111-4111-8111-111111111111",
      claim_id: "22222222-2222-4222-8222-222222222222",
      evidence_id: "33333333-3333-4333-8333-333333333333",
      changed_paths: ["src/file.ts"],
      provenance: { source: "file" },
      remediation: "Capture the evidence again.",
      line: 4,
    },
  ],
});

describe("SARIF 2.1.0 output", () => {
  it("validates against the pinned schema and emits stable rule metadata", async () => {
    const packageMetadata = JSON.parse(await readFile("package.json", "utf8")) as {
      version: string;
    };
    expect(PACKAGE_VERSION).toBe(packageMetadata.version);
    const sarif = renderSarif(review, PACKAGE_VERSION);
    const schema = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(await readFile("test/fixtures/sarif-2.1.0.schema.json", "utf8")));
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema);
    expect(validate(sarif), JSON.stringify(validate.errors)).toBe(true);
    expect(sarif).toMatchObject({
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "rostra-decision-ci", version: PACKAGE_VERSION } },
          originalUriBaseIds: { "%SRCROOT%": { uri: pathToFileURL("/workspace/").href } },
          results: [
            {
              ruleId: "stale_evidence",
              level: "error",
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/file.ts", uriBaseId: "%SRCROOT%" },
                    region: { startLine: 4 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });
});
