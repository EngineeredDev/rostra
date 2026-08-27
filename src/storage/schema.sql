CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  canonical_root TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_thread_id TEXT REFERENCES threads(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX threads_workspace_order ON threads(workspace_id, created_at_ms, id);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE RESTRICT,
  question TEXT NOT NULL,
  protocol TEXT NOT NULL,
  result_status TEXT NOT NULL CHECK (result_status IN ('complete', 'partial')),
  outcome_status TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  execution_isolation TEXT NOT NULL CHECK (execution_isolation IN ('builtin_confined', 'host_unrestricted')),
  review_due_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX decisions_workspace_order ON decisions(workspace_id, created_at_ms, id);
CREATE INDEX decisions_thread_order ON decisions(workspace_id, thread_id, created_at_ms, id);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE RESTRICT,
  idempotency_key TEXT UNIQUE,
  request_fingerprint TEXT NOT NULL,
  canonical_request_json TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'dispatching', 'running', 'recovery_required', 'cancelling', 'succeeded', 'failed', 'cancelled')),
  row_version INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  dispatch_token TEXT,
  cancellation_reason TEXT,
  recovery_reason TEXT,
  next_event_seq INTEGER NOT NULL DEFAULT 1,
  result_status TEXT CHECK (result_status IN ('complete', 'partial')),
  result_json TEXT,
  decision_id TEXT REFERENCES decisions(id) ON DELETE RESTRICT,
  transcript_path TEXT,
  execution_isolation TEXT NOT NULL CHECK (execution_isolation IN ('builtin_confined', 'host_unrestricted')),
  build_id TEXT,
  config_digest TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER
) STRICT;
CREATE INDEX jobs_status_order ON jobs(status, created_at_ms, job_id);
CREATE INDEX jobs_fingerprint_active ON jobs(request_fingerprint, status, terminal_at_ms);

CREATE TABLE job_events (
  job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (job_id, seq)
) STRICT;

CREATE TABLE job_attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  attempt_kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'started', 'succeeded', 'failed', 'uncertain', 'cancelled')),
  external_started INTEGER NOT NULL DEFAULT 0 CHECK (external_started IN (0, 1)),
  response_id TEXT,
  response_digest TEXT,
  raw_response TEXT,
  error_type TEXT,
  error_message TEXT,
  execution_isolation TEXT NOT NULL CHECK (execution_isolation IN ('builtin_confined', 'host_unrestricted')),
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  started_at_ms INTEGER,
  terminal_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (job_id, stage_id, participant_id, attempt_kind, ordinal, request_digest)
) STRICT;
CREATE INDEX attempts_job_status ON job_attempts(job_id, status, created_at_ms);

CREATE TABLE job_checkpoints (
  job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  checkpoint_seq INTEGER NOT NULL,
  stage_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  state_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (job_id, checkpoint_seq),
  UNIQUE (job_id, stage_id, state_digest)
) STRICT;

CREATE TABLE job_processes (
  process_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE CASCADE,
  pid INTEGER NOT NULL,
  pid_started_at_ms INTEGER NOT NULL,
  process_group_id INTEGER,
  role TEXT NOT NULL CHECK (role IN ('supervisor', 'worker', 'adapter')),
  status TEXT NOT NULL CHECK (status IN ('running', 'exited', 'cleanup_uncertain')),
  created_at_ms INTEGER NOT NULL,
  exited_at_ms INTEGER
) STRICT;
CREATE INDEX processes_job_status ON job_processes(job_id, status);

CREATE TABLE supervisor_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_token TEXT NOT NULL,
  pid INTEGER NOT NULL,
  pid_started_at_ms INTEGER NOT NULL,
  build_id TEXT NOT NULL,
  config_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'ready', 'draining', 'stopped')),
  heartbeat_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE quality_metrics (
  adapter TEXT NOT NULL,
  model TEXT NOT NULL,
  domain TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  valid_attempts INTEGER NOT NULL DEFAULT 0,
  valid_ballots INTEGER NOT NULL DEFAULT 0,
  abstentions INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  latency_samples_json TEXT NOT NULL DEFAULT '[]',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  resolved_predictions INTEGER NOT NULL DEFAULT 0,
  brier_sum REAL NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (adapter, model, domain)
) STRICT;

CREATE TABLE decision_origins (
  job_id TEXT PRIMARY KEY,
  decision_id TEXT UNIQUE NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE decision_participants (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_family TEXT NOT NULL,
  reasoning_effort TEXT,
  selection_json TEXT,
  PRIMARY KEY (decision_id, participant_id)
) STRICT;
CREATE INDEX decision_participants_workspace ON decision_participants(workspace_id, decision_id);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  participant_id TEXT,
  claim_type TEXT NOT NULL CHECK (claim_type IN ('fact', 'assumption', 'prediction', 'risk', 'recommendation')),
  text TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX claims_workspace_decision ON claims(workspace_id, decision_id, created_at_ms, id);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  canonical_uri TEXT NOT NULL,
  locator TEXT,
  content_hash TEXT NOT NULL,
  captured_commit_sha TEXT,
  captured_at_ms INTEGER NOT NULL,
  tool_or_adapter TEXT NOT NULL,
  execution_isolation TEXT NOT NULL CHECK (execution_isolation IN ('builtin_confined', 'host_unrestricted')),
  redaction_status TEXT NOT NULL CHECK (redaction_status IN ('none', 'redacted')),
  expires_at_ms INTEGER
) STRICT;
CREATE INDEX evidence_workspace_uri ON evidence(workspace_id, canonical_uri, captured_at_ms, id);

CREATE TABLE claim_evidence (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  polarity TEXT NOT NULL CHECK (polarity IN ('supports', 'refutes', 'neutral')),
  is_critical INTEGER NOT NULL CHECK (is_critical IN (0, 1)),
  PRIMARY KEY (claim_id, evidence_id)
) STRICT;
CREATE INDEX claim_evidence_workspace ON claim_evidence(workspace_id, evidence_id);

CREATE TABLE predictions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  model TEXT NOT NULL,
  domain TEXT NOT NULL,
  probability REAL NOT NULL CHECK (probability >= 0 AND probability <= 1),
  target_date TEXT NOT NULL,
  resolution_criteria TEXT NOT NULL,
  resolved_label INTEGER CHECK (resolved_label IN (0, 1)),
  resolved_at_ms INTEGER
) STRICT;
CREATE INDEX predictions_quality ON predictions(workspace_id, domain, adapter, model, resolved_at_ms, id);

CREATE TABLE outcomes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  prediction_id TEXT REFERENCES predictions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'disconfirmed', 'mixed', 'superseded', 'unknown')),
  observed_at TEXT NOT NULL,
  measurements_json TEXT NOT NULL,
  notes TEXT,
  superseding_decision_id TEXT REFERENCES decisions(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX outcomes_workspace_decision ON outcomes(workspace_id, decision_id, created_at_ms, id);

CREATE TABLE decision_relations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  target_decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('depends_on', 'contradicts', 'supersedes', 'related')),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (workspace_id, source_decision_id, target_decision_id, relation_type)
) STRICT;
CREATE INDEX relations_workspace_target ON decision_relations(workspace_id, target_decision_id, relation_type);

CREATE TABLE similarities (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  left_decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  right_decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL,
  score REAL NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (left_decision_id, right_decision_id, provider_key)
) STRICT;
CREATE INDEX similarities_workspace_score ON similarities(workspace_id, score DESC, left_decision_id, right_decision_id);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX reviews_workspace_order ON reviews(workspace_id, created_at_ms, id);

CREATE TABLE ci_findings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  claim_id TEXT REFERENCES claims(id) ON DELETE CASCADE,
  evidence_id TEXT REFERENCES evidence(id) ON DELETE CASCADE,
  finding_type TEXT NOT NULL CHECK (finding_type IN ('stale_evidence', 'changed_assumption', 'conflicting_decision', 'superseded_precedent', 'outcome_regression')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  changed_paths_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  remediation TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX ci_findings_workspace_review ON ci_findings(workspace_id, review_id, severity, id);

CREATE TABLE derived_operations (
  operation_key TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
