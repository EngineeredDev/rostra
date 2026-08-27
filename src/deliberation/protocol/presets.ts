import type { StageKind } from "../../config/schema.js";

export interface PresetStage {
  id: string;
  kind: StageKind;
  visibility: "question_only" | "anonymized_prior" | "full_prior";
  allowedCapabilities: readonly string[];
  minimumCompletions: number;
  stoppingPolicy: "continue" | "qualified_decision" | "impasse";
}

function stage(
  id: string,
  kind: StageKind,
  options: Partial<Omit<PresetStage, "id" | "kind">> = {},
): PresetStage {
  return {
    id,
    kind,
    visibility: options.visibility ?? "anonymized_prior",
    allowedCapabilities: options.allowedCapabilities ?? [],
    minimumCompletions: options.minimumCompletions ?? 1,
    stoppingPolicy: options.stoppingPolicy ?? "continue",
  };
}

export const shippedPresets: Readonly<Record<string, readonly PresetStage[]>> = {
  quick: [
    stage("analysis", "independent_analysis", { visibility: "question_only" }),
    stage("ballot", "final_ballot", { stoppingPolicy: "qualified_decision" }),
  ],
  conference: [
    stage("analysis", "independent_analysis", { visibility: "question_only" }),
    stage("critique", "critique"),
    stage("revision", "revision"),
    stage("ballot", "final_ballot", { stoppingPolicy: "qualified_decision" }),
  ],
  red_team: [
    stage("proposal", "proposal", { visibility: "question_only" }),
    stage("attack", "adversarial_attack"),
    stage("defense", "defense"),
    stage("ballot", "final_ballot", { stoppingPolicy: "qualified_decision" }),
  ],
  delphi: [
    stage("analysis", "independent_analysis", { visibility: "question_only" }),
    stage("aggregate", "anonymous_aggregate", { minimumCompletions: 0 }),
    stage("revision", "revision"),
    stage("ballot", "final_ballot", { stoppingPolicy: "qualified_decision" }),
  ],
  premortem: [
    stage("premortem", "premortem", { visibility: "question_only" }),
    stage("revision", "revision"),
    stage("ballot", "final_ballot", { stoppingPolicy: "qualified_decision" }),
  ],
  evidence_tribunal: [
    stage("proposal", "proposal", { visibility: "question_only" }),
    stage("evidence", "evidence_collection", {
      allowedCapabilities: [
        "read_file",
        "search_files",
        "list_files",
        "get_file_tree",
        "git_status",
        "git_diff",
      ],
    }),
    stage("examination", "cross_examination"),
    stage("adjudication", "adjudication"),
    stage("ballot", "final_ballot", { stoppingPolicy: "qualified_decision" }),
  ],
};
