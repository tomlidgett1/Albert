BEGIN;

INSERT INTO control_plane.answer_state_lookup(state,description) VALUES
  ('derived','Deterministic analytical computation over governed evidence.'),
  ('no_data','A valid governed question executed successfully but returned no matching records.')
ON CONFLICT (state) DO UPDATE SET description=excluded.description;

CREATE TABLE control_plane.semantic_v2_draft_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO control_plane.semantic_v2_draft_status_lookup(status,description) VALUES
  ('draft','Mutable semantic content under active authoring.'),
  ('validating','A deterministic validation is running for the pinned revision.'),
  ('review','The pinned revision is awaiting its risk-tier review.'),
  ('publishable','The pinned revision passed validation and review.'),
  ('superseded','A newer draft or publication replaced this draft.');

CREATE TABLE control_plane.semantic_v2_validation_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO control_plane.semantic_v2_validation_status_lookup(status,description) VALUES
  ('passed','All required deterministic checks completed successfully.'),
  ('failed','One or more required deterministic checks failed.');

CREATE TABLE control_plane.semantic_v2_profile_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO control_plane.semantic_v2_profile_status_lookup(status,description) VALUES
  ('complete','The live profiling receipt completed without unresolved execution errors.'),
  ('incomplete','At least one source or relationship profile could not be completed.');

CREATE TABLE control_plane.query_workspace_v2_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO control_plane.query_workspace_v2_status_lookup(status,description) VALUES
  ('draft','The workspace is mutable and has not passed deterministic validation.'),
  ('validated','The exact workspace revision passed deterministic validation.'),
  ('executed','The exact workspace revision has an immutable execution snapshot.'),
  ('failed','The workspace reached a typed validation or execution failure.');

CREATE TABLE control_plane.investigation_v2_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO control_plane.investigation_v2_status_lookup(status,description) VALUES
  ('draft','The inspectable investigation plan is still being assembled.'),
  ('running','The bounded evidence graph is executing.'),
  ('sufficient','The evidence graph satisfied its declared stopping conditions.'),
  ('inconclusive','The evidence budget ended without enough support for a conclusion.');

CREATE TABLE control_plane.insight_v2_state_lookup (
  state text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO control_plane.insight_v2_state_lookup(state,description) VALUES
  ('active','The finding remains current and unresolved.'),
  ('accepted','The user accepted the finding or associated action.'),
  ('rejected','The user rejected the finding or its applicability.'),
  ('resolved','The finding is no longer active because its issue was resolved.'),
  ('superseded','A materially newer finding replaced this ledger entry.');

CREATE TABLE control_plane.semantic_v2_drafts (
  draft_id text PRIMARY KEY CHECK (control_plane.is_ulid(draft_id)),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  base_publication_hash text CHECK (base_publication_hash IS NULL OR base_publication_hash~'^[a-f0-9]{64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  status text NOT NULL DEFAULT 'draft' REFERENCES control_plane.semantic_v2_draft_status_lookup(status),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object' AND manifest->>'schemaVersion'='2'),
  manifest_hash text NOT NULL CHECK (manifest_hash~'^[a-f0-9]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (updated_at>=created_at)
);

CREATE TABLE control_plane.semantic_v2_draft_revisions (
  draft_id text NOT NULL REFERENCES control_plane.semantic_v2_drafts(draft_id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision>0),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object' AND manifest->>'schemaVersion'='2'),
  manifest_hash text NOT NULL CHECK (manifest_hash~'^[a-f0-9]{64}$'),
  change_summary text NOT NULL CHECK (length(change_summary) BETWEEN 1 AND 1000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id,revision)
);

CREATE TABLE control_plane.semantic_v2_validation_reports (
  validation_id text PRIMARY KEY CHECK (control_plane.is_ulid(validation_id)),
  draft_id text NOT NULL REFERENCES control_plane.semantic_v2_drafts(draft_id) ON DELETE CASCADE,
  draft_revision integer NOT NULL CHECK (draft_revision>0),
  manifest_hash text NOT NULL CHECK (manifest_hash~'^[a-f0-9]{64}$'),
  status text NOT NULL REFERENCES control_plane.semantic_v2_validation_status_lookup(status),
  issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(issues)='array'),
  deterministic_test_receipt jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(deterministic_test_receipt)='object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id,draft_revision,manifest_hash)
);

CREATE TABLE control_plane.semantic_v2_object_reviews (
  review_id text PRIMARY KEY CHECK (control_plane.is_ulid(review_id)),
  draft_id text NOT NULL REFERENCES control_plane.semantic_v2_drafts(draft_id) ON DELETE CASCADE,
  draft_revision integer NOT NULL CHECK (draft_revision>0),
  object_id text NOT NULL CHECK (length(object_id) BETWEEN 1 AND 240),
  risk_tier text NOT NULL CHECK (risk_tier IN ('tier_1','tier_2','tier_3')),
  disposition text NOT NULL CHECK (disposition IN ('approved','changes_requested','sampled')),
  reviewer_id uuid NOT NULL,
  notes text CHECK (notes IS NULL OR length(notes)<=2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id,draft_revision,object_id,reviewer_id)
);

CREATE TABLE control_plane.semantic_v2_profile_receipts (
  profile_receipt_hash text PRIMARY KEY CHECK (profile_receipt_hash~'^[a-f0-9]{64}$'),
  publication_hash text NOT NULL CHECK (publication_hash~'^[a-f0-9]{64}$'),
  tenant_digest text NOT NULL CHECK (tenant_digest~'^[a-f0-9]{64}$'),
  status text NOT NULL REFERENCES control_plane.semantic_v2_profile_status_lookup(status),
  artifact jsonb NOT NULL CHECK (jsonb_typeof(artifact)='object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (artifact->>'publicationHash'=publication_hash),
  CHECK (artifact->>'tenantDigest'=tenant_digest),
  CHECK (artifact->>'status'=status)
);

CREATE TABLE control_plane.semantic_v2_publications (
  publication_hash text PRIMARY KEY CHECK (publication_hash~'^[a-f0-9]{64}$'),
  registry_version text NOT NULL CHECK (registry_version~'^\d+\.\d+\.\d+$'),
  schema_version integer NOT NULL CHECK (schema_version=2),
  artifact jsonb NOT NULL CHECK (jsonb_typeof(artifact)='object' AND artifact->>'schemaVersion'='2'),
  object_counts jsonb NOT NULL CHECK (jsonb_typeof(object_counts)='object'),
  validation_id text NOT NULL REFERENCES control_plane.semantic_v2_validation_reports(validation_id),
  source_draft_id text NOT NULL REFERENCES control_plane.semantic_v2_drafts(draft_id),
  source_draft_revision integer NOT NULL CHECK (source_draft_revision>0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control_plane.semantic_v2_active_publication (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  publication_hash text NOT NULL REFERENCES control_plane.semantic_v2_publications(publication_hash),
  previous_publication_hash text REFERENCES control_plane.semantic_v2_publications(publication_hash),
  activated_by uuid NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (previous_publication_hash IS DISTINCT FROM publication_hash)
);

CREATE TABLE control_plane.semantic_v2_activation_qualifications (
  qualification_id text PRIMARY KEY CHECK (control_plane.is_ulid(qualification_id)),
  publication_hash text NOT NULL REFERENCES control_plane.semantic_v2_publications(publication_hash),
  commit_sha text NOT NULL CHECK (commit_sha~'^[a-f0-9]{40}$'),
  status text NOT NULL REFERENCES control_plane.semantic_v2_validation_status_lookup(status),
  deterministic_receipt jsonb NOT NULL CHECK (jsonb_typeof(deterministic_receipt)='object'),
  model_evaluation_receipt jsonb CHECK (model_evaluation_receipt IS NULL OR jsonb_typeof(model_evaluation_receipt)='object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (publication_hash,commit_sha)
);

CREATE TABLE control_plane.query_workspaces_v2 (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL CHECK (control_plane.is_ulid(workspace_id)),
  question_id text NOT NULL CHECK (control_plane.is_ulid(question_id)),
  publication_hash text NOT NULL REFERENCES control_plane.semantic_v2_publications(publication_hash),
  overlay_version text NOT NULL CHECK (length(overlay_version) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  status text NOT NULL REFERENCES control_plane.query_workspace_v2_status_lookup(status),
  blocks jsonb NOT NULL CHECK (jsonb_typeof(blocks)='array'),
  created_by uuid,
  created_by_service text CHECK (created_by_service IS NULL OR length(created_by_service) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  derived_from_workspace_id text,
  derived_from_revision integer CHECK (derived_from_revision IS NULL OR derived_from_revision>0),
  PRIMARY KEY (tenant_id,workspace_id),
  CHECK (updated_at>=created_at),
  CHECK ((derived_from_workspace_id IS NULL)=(derived_from_revision IS NULL)),
  CHECK (created_by IS NOT NULL OR created_by_service IS NOT NULL)
);

CREATE TABLE control_plane.query_workspace_revisions_v2 (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  status text NOT NULL REFERENCES control_plane.query_workspace_v2_status_lookup(status),
  blocks jsonb NOT NULL CHECK (jsonb_typeof(blocks)='array'),
  workspace_hash text NOT NULL CHECK (workspace_hash~'^[a-f0-9]{64}$'),
  mutation jsonb NOT NULL CHECK (jsonb_typeof(mutation)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,workspace_id,revision),
  FOREIGN KEY (tenant_id,workspace_id)
    REFERENCES control_plane.query_workspaces_v2(tenant_id,workspace_id) ON DELETE CASCADE
);

ALTER TABLE control_plane.query_workspaces_v2
  ADD CONSTRAINT query_workspaces_v2_derivation_fkey
  FOREIGN KEY (tenant_id,derived_from_workspace_id,derived_from_revision)
  REFERENCES control_plane.query_workspace_revisions_v2(tenant_id,workspace_id,revision);

CREATE TABLE control_plane.query_execution_snapshots_v2 (
  tenant_id text NOT NULL,
  execution_id text NOT NULL CHECK (control_plane.is_ulid(execution_id)),
  workspace_id text NOT NULL,
  workspace_revision integer NOT NULL CHECK (workspace_revision>0),
  publication_hash text NOT NULL REFERENCES control_plane.semantic_v2_publications(publication_hash),
  normalized_plan_hash text NOT NULL CHECK (normalized_plan_hash~'^[a-f0-9]{64}$'),
  cache_key text NOT NULL CHECK (cache_key~'^[a-f0-9]{64}$'),
  cached_from_execution_id text,
  compiler_output_hash text NOT NULL CHECK (compiler_output_hash~'^[a-f0-9]{64}$'),
  result_digest text NOT NULL CHECK (result_digest~'^[a-f0-9]{64}$'),
  source_watermarks jsonb NOT NULL CHECK (jsonb_typeof(source_watermarks)='object'),
  validation jsonb NOT NULL CHECK (jsonb_typeof(validation)='object'),
  terminal_state text NOT NULL REFERENCES control_plane.answer_state_lookup(state),
  executed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,execution_id),
  FOREIGN KEY (tenant_id,cached_from_execution_id)
    REFERENCES control_plane.query_execution_snapshots_v2(tenant_id,execution_id),
  FOREIGN KEY (tenant_id,workspace_id,workspace_revision)
    REFERENCES control_plane.query_workspace_revisions_v2(tenant_id,workspace_id,revision)
);

CREATE INDEX query_execution_snapshots_v2_cache_lookup
  ON control_plane.query_execution_snapshots_v2(
    tenant_id,cache_key,executed_at DESC
  );

CREATE TABLE control_plane.evidence_artifacts_v2 (
  tenant_id text NOT NULL,
  evidence_id text NOT NULL CHECK (control_plane.is_ulid(evidence_id)),
  execution_id text NOT NULL,
  evidence_type text NOT NULL CHECK (evidence_type IN ('result','cell','operator','claim','limitation')),
  artifact jsonb NOT NULL CHECK (jsonb_typeof(artifact)='object'),
  artifact_digest text NOT NULL CHECK (artifact_digest~'^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,evidence_id),
  FOREIGN KEY (tenant_id,execution_id)
    REFERENCES control_plane.query_execution_snapshots_v2(tenant_id,execution_id)
);

CREATE TABLE control_plane.semantic_result_cache_v2 (
  tenant_id text NOT NULL,
  cache_key text NOT NULL CHECK (cache_key~'^[a-f0-9]{64}$'),
  publication_hash text NOT NULL REFERENCES control_plane.semantic_v2_publications(publication_hash),
  overlay_version text NOT NULL CHECK (length(overlay_version) BETWEEN 1 AND 120),
  normalized_plan_hash text NOT NULL CHECK (normalized_plan_hash~'^[a-f0-9]{64}$'),
  connection_set jsonb NOT NULL CHECK (jsonb_typeof(connection_set)='array'),
  source_watermarks jsonb NOT NULL CHECK (jsonb_typeof(source_watermarks)='object'),
  execution_payload jsonb NOT NULL CHECK (jsonb_typeof(execution_payload)='object'),
  result_digest text NOT NULL CHECK (result_digest~'^[a-f0-9]{64}$'),
  origin_execution_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,cache_key),
  FOREIGN KEY (tenant_id,origin_execution_id)
    REFERENCES control_plane.query_execution_snapshots_v2(tenant_id,execution_id)
);

CREATE TABLE control_plane.investigation_plans_v2 (
  tenant_id text NOT NULL,
  investigation_id text NOT NULL CHECK (control_plane.is_ulid(investigation_id)),
  conversation_id text NOT NULL CHECK (control_plane.is_ulid(conversation_id)),
  turn_id text NOT NULL CHECK (control_plane.is_ulid(turn_id)),
  objective text NOT NULL CHECK (length(objective) BETWEEN 1 AND 2000),
  question_class text NOT NULL CHECK (question_class IN ('lookup','comparison','diagnosis','recommendation','open_exploration')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  status text NOT NULL REFERENCES control_plane.investigation_v2_status_lookup(status),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,investigation_id),
  UNIQUE (tenant_id,turn_id),
  CHECK (updated_at>=created_at)
);

CREATE TABLE control_plane.investigation_plan_revisions_v2 (
  tenant_id text NOT NULL,
  investigation_id text NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  status text NOT NULL REFERENCES control_plane.investigation_v2_status_lookup(status),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object'),
  plan_digest text NOT NULL CHECK (plan_digest~'^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,investigation_id,revision),
  FOREIGN KEY (tenant_id,investigation_id)
    REFERENCES control_plane.investigation_plans_v2(tenant_id,investigation_id) ON DELETE CASCADE
);

CREATE TABLE control_plane.business_context_v2 (
  tenant_id text NOT NULL,
  context_id text NOT NULL CHECK (control_plane.is_ulid(context_id)),
  context_key text NOT NULL CHECK (context_key~'^[a-z][a-z0-9_.]{0,159}$'),
  version integer NOT NULL CHECK (version>0),
  value jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('system','lightspeed','xero','operator','tenant_confirmation')),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence)='array'),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,context_id),
  UNIQUE (tenant_id,context_key,version),
  CHECK (valid_to IS NULL OR valid_to>valid_from)
);

CREATE UNIQUE INDEX business_context_v2_one_current
  ON control_plane.business_context_v2(tenant_id,context_key)
  WHERE valid_to IS NULL;

CREATE TABLE control_plane.business_context_snapshots_v2 (
  tenant_id text NOT NULL,
  overlay_hash text NOT NULL CHECK (overlay_hash~'^[a-f0-9]{64}$'),
  context_snapshot jsonb NOT NULL CHECK (jsonb_typeof(context_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,overlay_hash)
);

CREATE TABLE control_plane.insight_ledger_v2 (
  tenant_id text NOT NULL,
  insight_id text NOT NULL CHECK (control_plane.is_ulid(insight_id)),
  insight_key text NOT NULL CHECK (insight_key~'^[a-f0-9]{64}$'),
  objective text NOT NULL CHECK (length(objective) BETWEEN 1 AND 1000),
  state text NOT NULL REFERENCES control_plane.insight_v2_state_lookup(state),
  magnitude numeric(19,4),
  unit text CHECK (unit IS NULL OR length(unit)<=40),
  novelty numeric(7,6) NOT NULL DEFAULT 1 CHECK (novelty BETWEEN 0 AND 1),
  evidence_refs jsonb NOT NULL CHECK (jsonb_typeof(evidence_refs)='array'),
  evidence_digest text NOT NULL CHECK (evidence_digest~'^[a-f0-9]{64}$'),
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences>0),
  last_answer_artifact_id text,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  disposition_at timestamptz,
  associated_action text CHECK (associated_action IS NULL OR length(associated_action)<=2000),
  user_note text CHECK (user_note IS NULL OR length(user_note)<=2000),
  outcome jsonb,
  PRIMARY KEY (tenant_id,insight_id),
  UNIQUE (tenant_id,insight_key),
  CHECK (last_observed_at>=first_observed_at)
);

CREATE TABLE control_plane.semantic_runtime_events_v2 (
  tenant_id text NOT NULL,
  event_id text NOT NULL CHECK (control_plane.is_ulid(event_id)),
  turn_id text NOT NULL CHECK (control_plane.is_ulid(turn_id)),
  publication_hash text REFERENCES control_plane.semantic_v2_publications(publication_hash),
  event_kind text NOT NULL CHECK (event_kind IN ('routing_miss','clarification','unavailable','compilation_failure','execution_failure')),
  reason_code text NOT NULL CHECK (reason_code~'^[A-Z0-9_]{1,120}$'),
  question_digest text NOT NULL CHECK (question_digest~'^[a-f0-9]{64}$'),
  topic_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(topic_ids)='array'),
  object_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(object_ids)='array'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,event_id)
);

CREATE INDEX semantic_runtime_events_v2_health
  ON control_plane.semantic_runtime_events_v2(tenant_id,event_kind,created_at DESC);

CREATE OR REPLACE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
BEGIN
  IF TG_OP='DELETE'
     AND current_setting('albert.deletion_authorized',true)='on'
     AND to_jsonb(OLD) ? 'tenant_id' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'semantic V2 artifact is immutable' USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER semantic_v2_draft_revisions_immutable
  BEFORE UPDATE OR DELETE ON control_plane.semantic_v2_draft_revisions
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();
CREATE TRIGGER semantic_v2_validations_immutable
  BEFORE UPDATE OR DELETE ON control_plane.semantic_v2_validation_reports
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();
CREATE TRIGGER semantic_v2_profile_receipts_immutable
  BEFORE UPDATE OR DELETE ON control_plane.semantic_v2_profile_receipts
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();
CREATE TRIGGER semantic_v2_publications_immutable
  BEFORE UPDATE OR DELETE ON control_plane.semantic_v2_publications
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();
CREATE TRIGGER semantic_v2_activation_qualifications_immutable
  BEFORE UPDATE OR DELETE ON control_plane.semantic_v2_activation_qualifications
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();
CREATE TRIGGER query_workspace_revisions_v2_immutable
  BEFORE UPDATE OR DELETE ON control_plane.query_workspace_revisions_v2
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();
CREATE TRIGGER query_execution_snapshots_v2_immutable
  BEFORE UPDATE OR DELETE ON control_plane.query_execution_snapshots_v2
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();
CREATE TRIGGER evidence_artifacts_v2_immutable
  BEFORE UPDATE OR DELETE ON control_plane.evidence_artifacts_v2
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();
CREATE TRIGGER semantic_result_cache_v2_immutable
  BEFORE UPDATE OR DELETE ON control_plane.semantic_result_cache_v2
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();
CREATE TRIGGER investigation_plan_revisions_v2_immutable
  BEFORE UPDATE OR DELETE ON control_plane.investigation_plan_revisions_v2
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();
CREATE TRIGGER business_context_snapshots_v2_immutable
  BEFORE UPDATE OR DELETE ON control_plane.business_context_snapshots_v2
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();
CREATE TRIGGER semantic_runtime_events_v2_immutable
  BEFORE UPDATE OR DELETE ON control_plane.semantic_runtime_events_v2
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();

ALTER TABLE control_plane.semantic_v2_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_draft_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_draft_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_validation_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_validation_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_object_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_object_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_profile_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_profile_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_active_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_active_publication FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_activation_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_activation_qualifications FORCE ROW LEVEL SECURITY;

CREATE POLICY semantic_v2_drafts_internal_operator ON control_plane.semantic_v2_drafts
  FOR ALL TO authenticated USING (control_plane.is_internal_operator()) WITH CHECK (control_plane.is_internal_operator());
CREATE POLICY semantic_v2_draft_revisions_internal_operator ON control_plane.semantic_v2_draft_revisions
  FOR ALL TO authenticated USING (control_plane.is_internal_operator()) WITH CHECK (control_plane.is_internal_operator());
CREATE POLICY semantic_v2_validations_internal_operator ON control_plane.semantic_v2_validation_reports
  FOR ALL TO authenticated USING (control_plane.is_internal_operator()) WITH CHECK (control_plane.is_internal_operator());
CREATE POLICY semantic_v2_reviews_internal_operator ON control_plane.semantic_v2_object_reviews
  FOR ALL TO authenticated USING (control_plane.is_internal_operator()) WITH CHECK (control_plane.is_internal_operator());
CREATE POLICY semantic_v2_profile_receipts_internal_operator ON control_plane.semantic_v2_profile_receipts
  FOR ALL TO authenticated USING (control_plane.is_internal_operator()) WITH CHECK (control_plane.is_internal_operator());
CREATE POLICY semantic_v2_publications_internal_operator ON control_plane.semantic_v2_publications
  FOR ALL TO authenticated USING (control_plane.is_internal_operator()) WITH CHECK (control_plane.is_internal_operator());
CREATE POLICY semantic_v2_active_internal_operator ON control_plane.semantic_v2_active_publication
  FOR ALL TO authenticated USING (control_plane.is_internal_operator()) WITH CHECK (control_plane.is_internal_operator());
CREATE POLICY semantic_v2_activation_qualifications_internal_operator ON control_plane.semantic_v2_activation_qualifications
  FOR ALL TO authenticated USING (control_plane.is_internal_operator()) WITH CHECK (control_plane.is_internal_operator());
CREATE POLICY semantic_v2_publications_runtime ON control_plane.semantic_v2_publications
  FOR SELECT TO albert_semantic_control USING (true);
CREATE POLICY semantic_v2_active_runtime ON control_plane.semantic_v2_active_publication
  FOR SELECT TO albert_semantic_control USING (true);

ALTER TABLE control_plane.query_workspaces_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.query_workspaces_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.query_workspace_revisions_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.query_workspace_revisions_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.query_execution_snapshots_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.query_execution_snapshots_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.evidence_artifacts_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.evidence_artifacts_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_result_cache_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_result_cache_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.investigation_plans_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.investigation_plans_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.investigation_plan_revisions_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.investigation_plan_revisions_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.business_context_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.business_context_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.business_context_snapshots_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.business_context_snapshots_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.insight_ledger_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.insight_ledger_v2 FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_runtime_events_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_runtime_events_v2 FORCE ROW LEVEL SECURITY;

CREATE POLICY query_workspaces_v2_runtime ON control_plane.query_workspaces_v2
  FOR ALL TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));
CREATE POLICY query_workspace_revisions_v2_runtime ON control_plane.query_workspace_revisions_v2
  FOR ALL TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));
CREATE POLICY query_execution_snapshots_v2_runtime ON control_plane.query_execution_snapshots_v2
  FOR ALL TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));
CREATE POLICY evidence_artifacts_v2_runtime ON control_plane.evidence_artifacts_v2
  FOR ALL TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));
CREATE POLICY semantic_result_cache_v2_runtime ON control_plane.semantic_result_cache_v2
  FOR ALL TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));
CREATE POLICY investigation_plans_v2_runtime ON control_plane.investigation_plans_v2
  FOR ALL TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));
CREATE POLICY investigation_plan_revisions_v2_runtime ON control_plane.investigation_plan_revisions_v2
  FOR ALL TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));
CREATE POLICY business_context_v2_runtime ON control_plane.business_context_v2
  FOR ALL TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));
CREATE POLICY business_context_v2_internal_operator ON control_plane.business_context_v2
  FOR ALL TO authenticated
  USING (control_plane.is_internal_operator() AND tenant_id=control_plane.require_current_tenant_id())
  WITH CHECK (control_plane.is_internal_operator() AND tenant_id=control_plane.require_current_tenant_id());
CREATE POLICY business_context_snapshots_v2_runtime ON control_plane.business_context_snapshots_v2
  FOR ALL TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));
CREATE POLICY insight_ledger_v2_runtime ON control_plane.insight_ledger_v2
  FOR ALL TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));
CREATE POLICY semantic_runtime_events_v2_runtime ON control_plane.semantic_runtime_events_v2
  FOR ALL TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));
CREATE POLICY semantic_runtime_events_v2_internal_operator ON control_plane.semantic_runtime_events_v2
  FOR SELECT TO authenticated
  USING (control_plane.is_internal_operator() AND tenant_id=control_plane.require_current_tenant_id());

GRANT USAGE ON SCHEMA control_plane TO authenticated,albert_semantic_control;
GRANT SELECT,INSERT,UPDATE ON control_plane.semantic_v2_drafts TO authenticated;
GRANT SELECT,INSERT ON control_plane.semantic_v2_draft_revisions,
  control_plane.semantic_v2_validation_reports,
  control_plane.semantic_v2_object_reviews,
  control_plane.semantic_v2_profile_receipts TO authenticated;
GRANT SELECT,INSERT ON control_plane.semantic_v2_publications TO authenticated;
GRANT SELECT,INSERT,UPDATE ON control_plane.semantic_v2_active_publication TO authenticated;
GRANT SELECT,INSERT ON control_plane.semantic_v2_activation_qualifications TO authenticated;

GRANT SELECT ON control_plane.semantic_v2_publications,
  control_plane.semantic_v2_active_publication TO albert_semantic_control;
GRANT SELECT,INSERT,UPDATE ON control_plane.query_workspaces_v2 TO albert_semantic_control;
GRANT SELECT,INSERT ON control_plane.query_workspace_revisions_v2,
  control_plane.query_execution_snapshots_v2,
  control_plane.evidence_artifacts_v2,
  control_plane.semantic_result_cache_v2,
  control_plane.investigation_plan_revisions_v2 TO albert_semantic_control;
GRANT SELECT,INSERT,UPDATE ON control_plane.investigation_plans_v2 TO albert_semantic_control;
GRANT SELECT,INSERT,UPDATE ON control_plane.business_context_v2,
  control_plane.insight_ledger_v2 TO albert_semantic_control;
GRANT SELECT,INSERT ON control_plane.semantic_runtime_events_v2 TO albert_semantic_control;
GRANT SELECT ON control_plane.semantic_runtime_events_v2 TO authenticated;
GRANT SELECT,INSERT,UPDATE ON control_plane.business_context_v2 TO authenticated;
GRANT SELECT,INSERT ON control_plane.business_context_snapshots_v2 TO albert_semantic_control;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_set_business_context(
  p_context_id text,
  p_context_key text,
  p_expected_version integer,
  p_value jsonb,
  p_source text,
  p_evidence jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE
  v_tenant_id text:=control_plane.require_current_tenant_id();
  v_current_version integer;
  v_next_version integer;
  v_now timestamptz:=now();
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  IF NOT control_plane.is_ulid(p_context_id)
     OR p_context_key !~ '^[a-z][a-z0-9_.]{0,159}$'
     OR p_expected_version<0
     OR p_value IS NULL
     OR p_source NOT IN ('operator','tenant_confirmation')
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'array' THEN
    RAISE EXCEPTION 'business context mutation is invalid' USING ERRCODE='22023';
  END IF;
  SELECT version INTO v_current_version
    FROM control_plane.business_context_v2
   WHERE tenant_id=v_tenant_id AND context_key=p_context_key AND valid_to IS NULL
   FOR UPDATE;
  IF coalesce(v_current_version,0)<>p_expected_version THEN
    RAISE EXCEPTION 'business context revision conflict: expected %, current %',p_expected_version,coalesce(v_current_version,0)
      USING ERRCODE='40001';
  END IF;
  v_next_version:=coalesce(v_current_version,0)+1;
  UPDATE control_plane.business_context_v2 SET valid_to=v_now
   WHERE tenant_id=v_tenant_id AND context_key=p_context_key AND valid_to IS NULL;
  INSERT INTO control_plane.business_context_v2(
    tenant_id,context_id,context_key,version,value,source,evidence,valid_from,created_by
  ) VALUES (
    v_tenant_id,p_context_id,p_context_key,v_next_version,p_value,p_source,p_evidence,v_now,extensions.albert_auth_uid()
  );
  RETURN jsonb_build_object('contextId',p_context_id,'contextKey',p_context_key,'version',v_next_version,'source',p_source,'validFrom',v_now);
END;
$$;

REVOKE ALL ON FUNCTION public.albert_semantic_v2_set_business_context(text,text,integer,jsonb,text,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_set_business_context(text,text,integer,jsonb,text,jsonb) TO authenticated;

REVOKE ALL ON FUNCTION control_plane.prevent_semantic_v2_immutable_mutation() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION control_plane.finalize_semantic_v2_answer_artifact(
  p_tenant_id text,
  p_actor_user_id uuid,
  p_conversation_id text,
  p_turn_id text,
  p_provider_response_id text,
  p_provider_usage jsonb,
  p_answer_state text,
  p_turn_result_digest text,
  p_metering jsonb,
  p_query_executions jsonb,
  p_claims jsonb,
  p_investigation_id text
)
RETURNS TABLE(answer_artifact_id text,artifact_digest text,idempotent_replay boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  turn_row control_plane.conversation_turns%ROWTYPE;
  final_event jsonb;
  trace_document jsonb;
  interpreted_plan_document jsonb;
  validation_document jsonb;
  provenance_document jsonb;
  semantic_ir_document jsonb;
  result_digest_document jsonb;
  artifact_document jsonb;
  query_item jsonb;
  claim_item jsonb;
  query_count integer;
  distinct_query_count integer;
  distinct_bundle_count integer;
  resolved_bundle_hash text;
  resolved_answer_text text;
  resolved_trace_digest text;
  resolved_artifact_digest text;
  resolved_metering_digest text;
  existing_artifact_id text;
  existing_artifact_digest text;
  existing_usage_digest text;
  created_artifact_id text;
BEGIN
  IF current_setting('albert.tenant_id',true) IS DISTINCT FROM p_tenant_id
     OR NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_conversation_id)
     OR NOT control_plane.is_ulid(p_turn_id)
     OR p_actor_user_id IS NULL
     OR p_provider_response_id IS NULL OR length(btrim(p_provider_response_id)) NOT BETWEEN 1 AND 512
     OR p_provider_usage IS NULL OR jsonb_typeof(p_provider_usage)<>'object' OR octet_length(p_provider_usage::text)>1048576
     OR p_answer_state NOT IN ('verified','derived','exploratory','clarification','no_data','unavailable')
     OR p_turn_result_digest !~ '^sha256:[a-f0-9]{64}$'
     OR p_metering IS NULL OR jsonb_typeof(p_metering)<>'object'
     OR p_query_executions IS NULL OR jsonb_typeof(p_query_executions)<>'array'
     OR jsonb_array_length(p_query_executions)>20 OR octet_length(p_query_executions::text)>2097152
     OR p_claims IS NULL OR jsonb_typeof(p_claims)<>'array'
     OR jsonb_array_length(p_claims)>12 OR octet_length(p_claims::text)>1048576
     OR (p_investigation_id IS NOT NULL AND NOT control_plane.is_ulid(p_investigation_id)) THEN
    RAISE EXCEPTION 'Semantic V2 answer artefact finalization input is invalid' USING ERRCODE='22023';
  END IF;

  query_count:=jsonb_array_length(p_query_executions);
  SELECT count(DISTINCT item->>'queryAuditId') INTO distinct_query_count
    FROM jsonb_array_elements(p_query_executions) item;
  IF distinct_query_count<>query_count THEN
    RAISE EXCEPTION 'Semantic V2 execution references must be unique' USING ERRCODE='22023';
  END IF;
  FOR query_item IN SELECT value FROM jsonb_array_elements(p_query_executions) LOOP
    IF jsonb_typeof(query_item)<>'object'
       OR NOT control_plane.is_ulid(coalesce(query_item->>'queryAuditId',''))
       OR query_item->>'route'<>'semantic_v2'
       OR coalesce(query_item->>'bundleHash','') !~ '^[a-f0-9]{64}$'
       OR length(coalesce(query_item->>'registryVersion','')) NOT BETWEEN 1 AND 160
       OR jsonb_typeof(query_item->'normalizedIr')<>'object'
       OR coalesce(query_item->>'compilerOutputHash','') !~ '^[a-f0-9]{64}$'
       OR coalesce(query_item->>'resultDigest','') !~ '^[a-f0-9]{64}$'
       OR coalesce(query_item->>'answerState','') NOT IN ('verified','derived','exploratory','no_data','unavailable')
       OR jsonb_typeof(query_item->'validation')<>'object' THEN
      RAISE EXCEPTION 'Semantic V2 execution evidence is malformed' USING ERRCODE='22023';
    END IF;
  END LOOP;
  FOR claim_item IN SELECT value FROM jsonb_array_elements(p_claims) LOOP
    IF jsonb_typeof(claim_item)<>'object'
       OR length(coalesce(claim_item->>'id','')) NOT BETWEEN 1 AND 160
       OR length(coalesce(claim_item->>'text','')) NOT BETWEEN 1 AND 2000
       OR claim_item->>'type' NOT IN ('numeric','comparative','descriptive','causal','recommendation')
       OR claim_item->>'semanticState' NOT IN ('verified','derived','exploratory')
       OR jsonb_typeof(claim_item->'evidenceRefs')<>'array'
       OR jsonb_array_length(claim_item->'evidenceRefs') NOT BETWEEN 1 AND 40
       OR jsonb_typeof(claim_item->'limitations')<>'array' THEN
      RAISE EXCEPTION 'Semantic V2 grounded claim is malformed' USING ERRCODE='22023';
    END IF;
  END LOOP;

  IF p_answer_state='clarification' AND (query_count<>0 OR jsonb_array_length(p_claims)<>0) THEN
    RAISE EXCEPTION 'clarification cannot bind analytical evidence' USING ERRCODE='22023';
  END IF;
  IF p_answer_state='no_data' AND (query_count=0 OR jsonb_array_length(p_claims)<>0 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_query_executions) item WHERE item->>'answerState'<>'no_data'
  )) THEN
    RAISE EXCEPTION 'no-data requires only valid empty executions' USING ERRCODE='22023';
  END IF;
  IF p_answer_state IN ('verified','derived','exploratory') AND (query_count=0 OR jsonb_array_length(p_claims)=0) THEN
    RAISE EXCEPTION 'analytical answers require executions and grounded claims' USING ERRCODE='22023';
  END IF;
  IF p_answer_state='verified' AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_claims) item WHERE item->>'semanticState'<>'verified'
  ) THEN RAISE EXCEPTION 'verified answer contains lower-confidence claims' USING ERRCODE='22023'; END IF;
  IF p_answer_state='derived' AND (
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_claims) item WHERE item->>'semanticState'='derived')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_claims) item WHERE item->>'semanticState'='exploratory')
  ) THEN RAISE EXCEPTION 'derived answer has invalid claim confidence' USING ERRCODE='22023'; END IF;
  IF p_answer_state='exploratory' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_claims) item WHERE item->>'semanticState'='exploratory'
  ) THEN RAISE EXCEPTION 'exploratory answer requires an exploratory claim' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM control_plane.tenants tenant
   WHERE tenant.tenant_id=p_tenant_id AND tenant.status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'answer finalization fenced by tenant deletion' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM control_plane.connections connection WHERE connection.tenant_id=p_tenant_id FOR SHARE;
  IF EXISTS(SELECT 1 FROM control_plane.deletion_requests request
    WHERE request.tenant_id=p_tenant_id AND request.status IN ('queued','running','retry_wait','verifying','failed')) THEN
    RAISE EXCEPTION 'answer finalization fenced by deletion' USING ERRCODE='55000';
  END IF;

  SELECT candidate.* INTO turn_row
    FROM control_plane.conversation_turns candidate
    JOIN control_plane.conversations conversation
      ON conversation.tenant_id=candidate.tenant_id AND conversation.conversation_id=candidate.conversation_id
   WHERE candidate.tenant_id=p_tenant_id AND candidate.conversation_id=p_conversation_id
     AND candidate.turn_id=p_turn_id AND candidate.created_by=p_actor_user_id
     AND conversation.created_by=p_actor_user_id
   FOR UPDATE OF candidate;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation turn was not found' USING ERRCODE='P0002'; END IF;
  IF turn_row.status NOT IN ('running','completed') THEN
    RAISE EXCEPTION 'only a running or identically completed turn can be finalized' USING ERRCODE='55000';
  END IF;

  SELECT coalesce(jsonb_agg(event.event ORDER BY event.sequence_number),'[]'::jsonb)
    INTO trace_document FROM control_plane.conversation_turn_events event
   WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id;
  IF jsonb_array_length(trace_document)=0 THEN
    RAISE EXCEPTION 'a finalized answer requires a persisted public trace' USING ERRCODE='55000';
  END IF;
  SELECT event.event INTO final_event FROM control_plane.conversation_turn_events event
   WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id AND event.event->>'type'='answer'
   ORDER BY event.sequence_number DESC LIMIT 1;
  IF final_event IS NULL
     OR replace(lower(coalesce(final_event->>'state','')),' ','_')<>p_answer_state THEN
    RAISE EXCEPTION 'Semantic V2 answer state does not match the final visible trace event' USING ERRCODE='22023';
  END IF;
  resolved_answer_text:=final_event->>'text';
  IF length(btrim(coalesce(resolved_answer_text,''))) NOT BETWEEN 1 AND 16000 THEN
    RAISE EXCEPTION 'final visible narrative is missing or invalid' USING ERRCODE='22023';
  END IF;

  IF EXISTS(
    SELECT 1 FROM control_plane.conversation_turn_events event
     WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id AND event.event->>'type'='table'
       AND NOT EXISTS(
         SELECT 1 FROM jsonb_array_elements(p_query_executions) query
          WHERE query->>'queryAuditId'=split_part(event.event->>'resultId',':',1)
            AND query->>'bundleHash'=event.event#>>'{provenance,semanticBundleHash}'
       )
  ) THEN RAISE EXCEPTION 'a visible V2 table is missing immutable execution evidence' USING ERRCODE='22023'; END IF;

  SELECT jsonb_build_object('kind','investigation_plan_v2','investigationId',p_investigation_id,
    'steps',coalesce(jsonb_agg(event.event ORDER BY event.sequence_number)
      FILTER(WHERE event.event->>'type' IN ('progress','narrative','query')),'[]'::jsonb))
    INTO interpreted_plan_document FROM control_plane.conversation_turn_events event
   WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id;
  SELECT coalesce(jsonb_agg(event.event ORDER BY event.sequence_number)
    FILTER(WHERE event.event->>'type'='validation'),'[]'::jsonb)
    INTO validation_document FROM control_plane.conversation_turn_events event
   WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id;
  provenance_document:=coalesce(final_event->'provenance','{}'::jsonb);
  semantic_ir_document:=CASE WHEN query_count=0 THEN NULL ELSE jsonb_build_object(
    'schemaVersion',2,'executions',(
      SELECT jsonb_agg(jsonb_build_object('executionId',query->>'queryAuditId','plan',query->'normalizedIr') ORDER BY ordinal)
      FROM jsonb_array_elements(p_query_executions) WITH ORDINALITY source(query,ordinal)
    )) END;
  result_digest_document:=jsonb_build_object('turn',p_turn_result_digest,'executions',(
    SELECT coalesce(jsonb_agg(jsonb_build_object('executionId',query->>'queryAuditId','resultDigest',query->>'resultDigest') ORDER BY ordinal),'[]'::jsonb)
    FROM jsonb_array_elements(p_query_executions) WITH ORDINALITY source(query,ordinal)
  ));
  SELECT count(DISTINCT query->>'bundleHash'),min(query->>'bundleHash')
    INTO distinct_bundle_count,resolved_bundle_hash FROM jsonb_array_elements(p_query_executions) query;
  IF distinct_bundle_count<>1 THEN resolved_bundle_hash:=NULL; END IF;
  resolved_trace_digest:=encode(extensions.digest(convert_to(trace_document::text,'UTF8'),'sha256'),'hex');
  resolved_metering_digest:=encode(extensions.digest(convert_to(p_metering::text,'UTF8'),'sha256'),'hex');
  artifact_document:=jsonb_build_object(
    'schemaVersion',2,'tenantId',p_tenant_id,'conversationId',p_conversation_id,'turnId',p_turn_id,
    'turnNumber',turn_row.turn_number,'questionText',turn_row.user_message,'answerState',p_answer_state,
    'finalNarrative',resolved_answer_text,'interpretedPlan',interpreted_plan_document,
    'semanticIr',semantic_ir_document,'queryExecutions',p_query_executions,'claims',p_claims,
    'investigationId',p_investigation_id,'resultDigest',result_digest_document,
    'validationOutcomes',validation_document,'provenance',provenance_document,
    'semanticBundleHash',resolved_bundle_hash,'traceDigest',resolved_trace_digest,
    'runtimeProfile',turn_row.runtime_profile,'providerResponseId',p_provider_response_id,
    'providerUsage',p_provider_usage,'modelUsageDigest',resolved_metering_digest
  );
  resolved_artifact_digest:=encode(extensions.digest(convert_to(artifact_document::text,'UTF8'),'sha256'),'hex');

  SELECT artifact.answer_artifact_id,artifact.artifact_digest
    INTO existing_artifact_id,existing_artifact_digest FROM control_plane.answer_artifacts artifact
   WHERE artifact.tenant_id=p_tenant_id AND artifact.turn_id=p_turn_id;
  IF existing_artifact_id IS NOT NULL THEN
    IF existing_artifact_digest IS DISTINCT FROM resolved_artifact_digest OR turn_row.status<>'completed' THEN
      RAISE EXCEPTION 'turn was already finalized with different evidence' USING ERRCODE='23505';
    END IF;
    answer_artifact_id:=existing_artifact_id; artifact_digest:=existing_artifact_digest; idempotent_replay:=true;
    RETURN NEXT; RETURN;
  END IF;
  IF turn_row.status<>'running' THEN RAISE EXCEPTION 'completed turn is missing its immutable answer artefact' USING ERRCODE='55000'; END IF;

  IF p_metering->>'model' IS DISTINCT FROM turn_row.runtime_profile->>'model'
     OR (p_metering->>'fastMode')::boolean IS DISTINCT FROM coalesce((turn_row.runtime_profile->>'fastMode')::boolean,false)
     OR p_metering->>'model' NOT IN ('gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna')
     OR p_metering->>'pricingCompleteness' NOT IN ('request_level','aggregate_estimate')
     OR coalesce(p_metering->>'rateCardId','') !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
     OR coalesce(p_metering->>'requests','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'inputTokens','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'cachedInputTokens','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'cacheWriteInputTokens','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'outputTokens','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'estimatedCostUsdMicros','') !~ '^[0-9]+$'
     OR (p_metering->>'cachedInputTokens')::bigint+(p_metering->>'cacheWriteInputTokens')::bigint>(p_metering->>'inputTokens')::bigint THEN
    RAISE EXCEPTION 'model metering does not match the turn' USING ERRCODE='22023';
  END IF;
  SELECT ledger.metering_digest INTO existing_usage_digest FROM control_plane.model_usage_ledger ledger
   WHERE ledger.tenant_id=p_tenant_id AND ledger.turn_id=p_turn_id;
  IF existing_usage_digest IS NOT NULL AND existing_usage_digest<>resolved_metering_digest THEN
    RAISE EXCEPTION 'turn usage was already recorded differently' USING ERRCODE='23505';
  END IF;
  IF existing_usage_digest IS NULL THEN
    INSERT INTO control_plane.model_usage_ledger(
      tenant_id,usage_ledger_id,conversation_id,turn_id,rate_card_id,model,fast_mode,requests,
      input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,estimated_cost_usd_micros,
      pricing_completeness,metering_digest,recorded_by
    ) VALUES (
      p_tenant_id,control_plane.generate_ulid(),p_conversation_id,p_turn_id,p_metering->>'rateCardId',p_metering->>'model',
      (p_metering->>'fastMode')::boolean,(p_metering->>'requests')::integer,(p_metering->>'inputTokens')::bigint,
      (p_metering->>'cachedInputTokens')::bigint,(p_metering->>'cacheWriteInputTokens')::bigint,
      (p_metering->>'outputTokens')::bigint,(p_metering->>'estimatedCostUsdMicros')::bigint,
      p_metering->>'pricingCompleteness',resolved_metering_digest,p_actor_user_id
    );
  END IF;

  created_artifact_id:=control_plane.generate_ulid();
  INSERT INTO control_plane.answer_artifacts(
    tenant_id,answer_artifact_id,conversation_id,turn_id,turn_number,answer_state,question_text,answer_text,
    interpreted_plan,semantic_ir,compiled_sql,result_digest,validation_outcomes,provenance,semantic_bundle_hash,
    trace_digest,artifact_digest,query_executions,runtime_profile,provider_response_id,provider_usage,model_usage_digest,finalized_at
  ) VALUES (
    p_tenant_id,created_artifact_id,p_conversation_id,p_turn_id,turn_row.turn_number,p_answer_state,
    turn_row.user_message,resolved_answer_text,interpreted_plan_document,semantic_ir_document,NULL,result_digest_document,
    validation_document,provenance_document,resolved_bundle_hash,resolved_trace_digest,resolved_artifact_digest,
    p_query_executions,turn_row.runtime_profile,p_provider_response_id,p_provider_usage,resolved_metering_digest,now()
  );
  INSERT INTO control_plane.answer_execution_events(
    tenant_id,execution_event_id,answer_artifact_id,source_turn_event_id,conversation_id,turn_id,
    sequence_number,event_type,event_payload,occurred_at
  ) SELECT event.tenant_id,control_plane.generate_ulid(),created_artifact_id,event.turn_event_id,
      event.conversation_id,event.turn_id,event.sequence_number,event.event->>'type',event.event,event.occurred_at
    FROM control_plane.conversation_turn_events event
   WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id ORDER BY event.sequence_number;
  UPDATE control_plane.conversation_turns SET status='completed',provider_response_id=p_provider_response_id,
      usage=p_provider_usage,answer_state=p_answer_state,result_digest=p_turn_result_digest,completed_at=now()
   WHERE tenant_id=p_tenant_id AND turn_id=p_turn_id AND status='running';
  IF NOT FOUND THEN RAISE EXCEPTION 'running turn changed during finalization' USING ERRCODE='40001'; END IF;
  UPDATE control_plane.conversations SET updated_at=now()
   WHERE tenant_id=p_tenant_id AND conversation_id=p_conversation_id;
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,resource_type,resource_id,audit_metadata
  ) VALUES (
    p_tenant_id,control_plane.generate_ulid(),p_actor_user_id,'user','answer_artifact.finalized_v2',
    'answer_artifact',created_artifact_id,jsonb_build_object('turn_id',p_turn_id,'answer_state',p_answer_state,
      'artifact_digest',resolved_artifact_digest,'trace_digest',resolved_trace_digest,'execution_count',query_count,
      'claim_count',jsonb_array_length(p_claims),'model_usage_digest',resolved_metering_digest)
  );
  answer_artifact_id:=created_artifact_id; artifact_digest:=resolved_artifact_digest; idempotent_replay:=false;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.finalize_semantic_v2_answer_artifact(text,uuid,text,text,text,jsonb,text,text,jsonb,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION control_plane.finalize_semantic_v2_answer_artifact(text,uuid,text,text,text,jsonb,text,text,jsonb,jsonb,jsonb,text) TO albert_semantic_control;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_create_draft(
  p_draft_id text,
  p_name text,
  p_manifest jsonb,
  p_manifest_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  INSERT INTO control_plane.semantic_v2_drafts(
    draft_id,name,revision,status,manifest,manifest_hash,created_by
  ) VALUES (
    p_draft_id,p_name,1,'draft',p_manifest,p_manifest_hash,extensions.albert_auth_uid()
  );
  INSERT INTO control_plane.semantic_v2_draft_revisions(
    draft_id,revision,manifest,manifest_hash,change_summary,created_by
  ) VALUES (
    p_draft_id,1,p_manifest,p_manifest_hash,'Created from the active or generated V2 publication.',extensions.albert_auth_uid()
  );
  RETURN jsonb_build_object('draftId',p_draft_id,'revision',1,'status','draft','manifestHash',p_manifest_hash);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_replace_draft(
  p_draft_id text,
  p_expected_revision integer,
  p_manifest jsonb,
  p_manifest_hash text,
  p_change_summary text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE
  v_revision integer;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  SELECT revision INTO v_revision
  FROM control_plane.semantic_v2_drafts
  WHERE draft_id=p_draft_id
  FOR UPDATE;
  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'semantic draft not found' USING ERRCODE='P0002';
  END IF;
  IF v_revision<>p_expected_revision THEN
    RAISE EXCEPTION 'semantic draft revision conflict: expected %, current %',p_expected_revision,v_revision
      USING ERRCODE='40001';
  END IF;
  v_revision:=v_revision+1;
  INSERT INTO control_plane.semantic_v2_draft_revisions(
    draft_id,revision,manifest,manifest_hash,change_summary,created_by
  ) VALUES (
    p_draft_id,v_revision,p_manifest,p_manifest_hash,p_change_summary,extensions.albert_auth_uid()
  );
  UPDATE control_plane.semantic_v2_drafts
  SET revision=v_revision,status='draft',manifest=p_manifest,manifest_hash=p_manifest_hash,updated_at=now()
  WHERE draft_id=p_draft_id;
  RETURN jsonb_build_object('draftId',p_draft_id,'revision',v_revision,'status','draft','manifestHash',p_manifest_hash);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_create_draft_from_active(
  p_draft_id text,
  p_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE
  v_manifest jsonb;
  v_publication_hash text;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  SELECT p.artifact->'manifest',p.publication_hash
  INTO v_manifest,v_publication_hash
  FROM control_plane.semantic_v2_active_publication a
  JOIN control_plane.semantic_v2_publications p ON p.publication_hash=a.publication_hash
  WHERE a.singleton;
  IF v_manifest IS NULL THEN
    RAISE EXCEPTION 'no active semantic V2 publication exists' USING ERRCODE='P0002';
  END IF;
  INSERT INTO control_plane.semantic_v2_drafts(
    draft_id,name,base_publication_hash,revision,status,manifest,manifest_hash,created_by
  ) VALUES (
    p_draft_id,p_name,v_publication_hash,1,'draft',v_manifest,v_publication_hash,extensions.albert_auth_uid()
  );
  INSERT INTO control_plane.semantic_v2_draft_revisions(
    draft_id,revision,manifest,manifest_hash,change_summary,created_by
  ) VALUES (
    p_draft_id,1,v_manifest,v_publication_hash,'Created from the active V2 publication.',extensions.albert_auth_uid()
  );
  RETURN jsonb_build_object('draftId',p_draft_id,'revision',1,'status','draft','manifestHash',v_publication_hash);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_record_review(
  p_review_id text,
  p_draft_id text,
  p_expected_revision integer,
  p_object_id text,
  p_risk_tier text,
  p_disposition text,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE
  v_revision integer;
  v_manifest jsonb;
  v_required_tier text;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  SELECT revision,manifest INTO v_revision,v_manifest FROM control_plane.semantic_v2_drafts WHERE draft_id=p_draft_id;
  IF v_revision IS NULL THEN RAISE EXCEPTION 'semantic draft not found' USING ERRCODE='P0002'; END IF;
  IF v_revision<>p_expected_revision THEN
    RAISE EXCEPTION 'semantic draft revision conflict' USING ERRCODE='40001';
  END IF;
  SELECT CASE
    WHEN object_type='measure' AND object_value->>'semanticState' IN ('verified','derived')
      THEN object_value->>'riskTier'
    WHEN object_type='relationship' AND object_value->>'semanticState' IN ('verified','derived')
      THEN 'tier_1'
    WHEN object_type='topic' AND object_value->>'layer'='composite'
      AND object_value->>'semanticState' IN ('verified','derived') THEN 'tier_1'
    WHEN object_type='field' AND (
      COALESCE((object_value->>'pii')::boolean,false)
      OR object_value->>'disposition'='sensitive_metadata'
    ) THEN 'tier_1'
    ELSE 'tier_3'
  END INTO v_required_tier
  FROM (
    SELECT 'measure' AS object_type,value AS object_value FROM jsonb_array_elements(v_manifest->'measures')
    UNION ALL SELECT 'relationship',value FROM jsonb_array_elements(v_manifest->'relationships')
    UNION ALL SELECT 'topic',value FROM jsonb_array_elements(v_manifest->'topics')
    UNION ALL SELECT 'field',field_value
      FROM jsonb_array_elements(v_manifest->'sourceObjects') source_value
      CROSS JOIN LATERAL jsonb_array_elements(source_value->'fields') field_value
  ) reviewable
  WHERE object_value->>'id'=p_object_id
  LIMIT 1;
  IF v_required_tier IS NULL THEN
    RAISE EXCEPTION 'semantic object is not reviewable' USING ERRCODE='22023';
  END IF;
  IF p_risk_tier<>v_required_tier THEN
    RAISE EXCEPTION 'review tier does not match the semantic contract' USING ERRCODE='22023';
  END IF;
  IF (v_required_tier IN ('tier_1','tier_2') AND p_disposition='sampled')
     OR (v_required_tier='tier_3' AND p_disposition='approved') THEN
    RAISE EXCEPTION 'review disposition does not match the semantic risk tier' USING ERRCODE='22023';
  END IF;
  INSERT INTO control_plane.semantic_v2_object_reviews(
    review_id,draft_id,draft_revision,object_id,risk_tier,disposition,reviewer_id,notes
  ) VALUES (p_review_id,p_draft_id,p_expected_revision,p_object_id,p_risk_tier,p_disposition,extensions.albert_auth_uid())
  ON CONFLICT (draft_id,draft_revision,object_id,reviewer_id)
  DO UPDATE SET risk_tier=excluded.risk_tier,disposition=excluded.disposition,notes=excluded.notes,created_at=now();
  RETURN jsonb_build_object('reviewId',p_review_id,'draftId',p_draft_id,'revision',p_expected_revision,'objectId',p_object_id,'disposition',p_disposition);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_publish_draft(
  p_draft_id text,
  p_expected_revision integer,
  p_validation_id text,
  p_publication_hash text,
  p_object_counts jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE
  v_draft control_plane.semantic_v2_drafts%ROWTYPE;
  v_validation control_plane.semantic_v2_validation_reports%ROWTYPE;
  v_object jsonb;
  v_approvals integer;
  v_required_tier text;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_draft FROM control_plane.semantic_v2_drafts WHERE draft_id=p_draft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'semantic draft not found' USING ERRCODE='P0002'; END IF;
  IF v_draft.revision<>p_expected_revision THEN RAISE EXCEPTION 'semantic draft revision conflict' USING ERRCODE='40001'; END IF;
  IF v_draft.manifest_hash<>p_publication_hash THEN RAISE EXCEPTION 'publication hash does not match the draft manifest' USING ERRCODE='22000'; END IF;
  SELECT * INTO v_validation FROM control_plane.semantic_v2_validation_reports WHERE validation_id=p_validation_id;
  IF NOT FOUND OR v_validation.draft_id<>p_draft_id OR v_validation.draft_revision<>p_expected_revision
     OR v_validation.manifest_hash<>p_publication_hash OR v_validation.status<>'passed' THEN
    RAISE EXCEPTION 'a passing validation for the exact draft revision is required' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.semantic_v2_object_reviews
    WHERE draft_id=p_draft_id AND draft_revision=p_expected_revision AND disposition='changes_requested'
  ) THEN RAISE EXCEPTION 'requested review changes remain unresolved' USING ERRCODE='23514'; END IF;
  FOR v_object,v_required_tier IN
    SELECT object_value,required_tier
    FROM (
      SELECT value AS object_value,value->>'riskTier' AS required_tier
      FROM jsonb_array_elements(v_draft.manifest->'measures')
      WHERE value->>'semanticState' IN ('verified','derived') AND value->>'riskTier' IN ('tier_1','tier_2')
      UNION ALL
      SELECT value,'tier_1'
      FROM jsonb_array_elements(v_draft.manifest->'relationships')
      WHERE value->>'semanticState' IN ('verified','derived')
      UNION ALL
      SELECT value,'tier_1'
      FROM jsonb_array_elements(v_draft.manifest->'topics')
      WHERE value->>'layer'='composite' AND value->>'semanticState' IN ('verified','derived')
      UNION ALL
      SELECT field_value,'tier_1'
      FROM jsonb_array_elements(v_draft.manifest->'sourceObjects') source_value
      CROSS JOIN LATERAL jsonb_array_elements(source_value->'fields') field_value
      WHERE COALESCE((field_value->>'pii')::boolean,false)
         OR field_value->>'disposition'='sensitive_metadata'
    ) required_reviews
  LOOP
    IF v_required_tier IN ('tier_1','tier_2') THEN
      SELECT count(DISTINCT reviewer_id) INTO v_approvals
      FROM control_plane.semantic_v2_object_reviews
      WHERE draft_id=p_draft_id AND draft_revision=p_expected_revision
        AND object_id=v_object->>'id' AND risk_tier=v_required_tier AND disposition='approved';
      IF (v_required_tier='tier_1' AND v_approvals<2) OR (v_required_tier='tier_2' AND v_approvals<1) THEN
        RAISE EXCEPTION 'review requirements are not satisfied for %',v_object->>'id' USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  INSERT INTO control_plane.semantic_v2_publications(
    publication_hash,registry_version,schema_version,artifact,object_counts,
    validation_id,source_draft_id,source_draft_revision,created_by
  ) VALUES (
    p_publication_hash,v_draft.manifest->>'registryVersion',2,
    jsonb_build_object(
      'schemaVersion',2,'registryVersion',v_draft.manifest->>'registryVersion',
      'publicationHash',p_publication_hash,'objectCounts',p_object_counts,'manifest',v_draft.manifest
    ),p_object_counts,p_validation_id,p_draft_id,p_expected_revision,extensions.albert_auth_uid()
  ) ON CONFLICT (publication_hash) DO NOTHING;
  UPDATE control_plane.semantic_v2_drafts SET status='publishable',updated_at=now() WHERE draft_id=p_draft_id;
  RETURN jsonb_build_object('publicationHash',p_publication_hash,'draftId',p_draft_id,'revision',p_expected_revision,'activationReady',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_activate_publication(p_publication_hash text,p_commit_sha text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE v_previous text;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501'; END IF;
  IF p_commit_sha IS NULL OR p_commit_sha!~'^[a-f0-9]{40}$' THEN RAISE EXCEPTION 'an exact 40-character release commit is required' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.semantic_v2_activation_qualifications
    WHERE publication_hash=p_publication_hash AND commit_sha=p_commit_sha AND status='passed'
  ) THEN RAISE EXCEPTION 'a passing activation qualification is required' USING ERRCODE='23514'; END IF;
  SELECT publication_hash INTO v_previous FROM control_plane.semantic_v2_active_publication WHERE singleton FOR UPDATE;
  IF v_previous=p_publication_hash THEN RETURN jsonb_build_object('publicationHash',p_publication_hash,'previousPublicationHash',v_previous,'changed',false); END IF;
  INSERT INTO control_plane.semantic_v2_active_publication(singleton,publication_hash,previous_publication_hash,activated_by,activated_at)
  VALUES (true,p_publication_hash,v_previous,extensions.albert_auth_uid(),now())
  ON CONFLICT (singleton) DO UPDATE SET
    publication_hash=excluded.publication_hash,previous_publication_hash=excluded.previous_publication_hash,
    activated_by=excluded.activated_by,activated_at=excluded.activated_at;
  RETURN jsonb_build_object('publicationHash',p_publication_hash,'previousPublicationHash',v_previous,'changed',true);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_rollback_publication()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE v_current text; v_previous text;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501'; END IF;
  SELECT publication_hash,previous_publication_hash INTO v_current,v_previous
  FROM control_plane.semantic_v2_active_publication WHERE singleton FOR UPDATE;
  IF v_previous IS NULL THEN RAISE EXCEPTION 'no previous semantic publication is available' USING ERRCODE='P0002'; END IF;
  UPDATE control_plane.semantic_v2_active_publication
  SET publication_hash=v_previous,previous_publication_hash=v_current,activated_by=extensions.albert_auth_uid(),activated_at=now()
  WHERE singleton;
  RETURN jsonb_build_object('publicationHash',v_previous,'previousPublicationHash',v_current,'changed',true);
END;
$$;

REVOKE ALL ON FUNCTION public.albert_semantic_v2_create_draft(text,text,jsonb,text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_replace_draft(text,integer,jsonb,text,text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_create_draft_from_active(text,text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_record_review(text,text,integer,text,text,text,text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_publish_draft(text,integer,text,text,jsonb) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_activate_publication(text,text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_rollback_publication() FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_create_draft(text,text,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_replace_draft(text,integer,jsonb,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_create_draft_from_active(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_record_review(text,text,integer,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_publish_draft(text,integer,text,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_activate_publication(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_rollback_publication() TO authenticated;

COMMIT;
