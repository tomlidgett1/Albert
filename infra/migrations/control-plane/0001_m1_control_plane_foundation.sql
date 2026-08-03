BEGIN;

-- Albert control-plane foundation (M1).
--
-- Ownership and runtime boundary:
--   * The migration-owner role applies this file and owns these objects. It is
--     a DDL-only deployment identity and must never be used by an application.
--   * service_role is reserved for trusted server processes and sync workers.
--     It is the only runtime role granted access to OAuth token references and
--     operational write paths.
--   * authenticated is a browser/auth-user role. Every tenant row it can read
--     or mutate is gated through an active membership derived from auth.uid().
--   * anon receives no access to this schema.
--
-- This migration deliberately creates no analytical tables, physical database
-- placement, vendor credentials, or plaintext/ciphertext OAuth token material.

CREATE SCHEMA IF NOT EXISTS control_plane;

COMMENT ON SCHEMA control_plane IS
  'Albert tenant control plane. DDL is migration-owner only; trusted runtime writes use service_role; authenticated access is membership-scoped by RLS.';

CREATE OR REPLACE FUNCTION control_plane.is_ulid(candidate text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT candidate ~ '^[0-9A-HJKMNP-TV-Z]{26}$';
$$;

-- Lookup-constrained text values. PostgreSQL enum types are intentionally not
-- used so lifecycle changes remain ordinary, reversible data migrations.

CREATE TABLE IF NOT EXISTS control_plane.tenant_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.tenant_role_lookup (
  role text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.membership_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.connection_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.connection_auth_health_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.sync_job_type_lookup (
  job_type text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.sync_run_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.readiness_state_lookup (
  state text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.version_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.publication_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.conversation_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.answer_state_lookup (
  state text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.identity_review_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.semantic_inbox_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.placement_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.tenant_status_lookup (status, description) VALUES
  ('active', 'Tenant is active'),
  ('suspended', 'Tenant access is suspended'),
  ('deleting', 'Tenant deletion is in progress'),
  ('deleted', 'Tenant deletion has completed')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.tenant_role_lookup (role, description) VALUES
  ('owner', 'Tenant owner'),
  ('manager', 'Operational manager'),
  ('bookkeeper', 'Finance-focused member')
ON CONFLICT (role) DO NOTHING;

INSERT INTO control_plane.membership_status_lookup (status, description) VALUES
  ('active', 'Membership is active'),
  ('invited', 'Membership invitation is pending'),
  ('suspended', 'Membership is suspended'),
  ('revoked', 'Membership has been revoked')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.connection_status_lookup (status, description) VALUES
  ('pending', 'Connection setup has started'),
  ('connected', 'Connection is authorised'),
  ('degraded', 'Connection is usable with a known issue'),
  ('blocked', 'Connection cannot currently sync'),
  ('disconnected', 'Connection has been disconnected')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.connection_auth_health_lookup (status, description) VALUES
  ('unknown', 'Credential health has not been checked'),
  ('healthy', 'Credential check succeeded'),
  ('expiring', 'Credential expiry is approaching'),
  ('expired', 'Credential has expired'),
  ('revoked', 'Vendor access was revoked'),
  ('error', 'Credential check failed')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.sync_job_type_lookup (job_type, description) VALUES
  ('InitialBackfill', 'Recent-first initial sync followed by historical slices'),
  ('IncrementalSync', 'Cursor-based incremental sync'),
  ('ReconciliationSweep', 'Lookback, deletion and source-total reconciliation')
ON CONFLICT (job_type) DO NOTHING;

INSERT INTO control_plane.sync_run_status_lookup (status, description) VALUES
  ('queued', 'Run is queued'),
  ('running', 'Run is executing'),
  ('retry_wait', 'Run is waiting before another attempt'),
  ('succeeded', 'Run completed successfully'),
  ('failed', 'Run exhausted its attempts'),
  ('cancelled', 'Run was cancelled')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.readiness_state_lookup (state, description) VALUES
  ('not_started', 'No work has started'),
  ('syncing', 'Source records are being ingested'),
  ('transforming', 'Canonical transformations are running'),
  ('validating', 'Quality gates are running'),
  ('ready_partial', 'Recent useful data is queryable while history continues'),
  ('ready_complete', 'Available history is queryable'),
  ('degraded', 'Queryable with a disclosed quality or freshness limitation'),
  ('blocked', 'Not queryable until the attached issue is resolved')
ON CONFLICT (state) DO NOTHING;

INSERT INTO control_plane.version_status_lookup (status, description) VALUES
  ('draft', 'Version is not active'),
  ('published', 'Version is active'),
  ('superseded', 'Version was replaced')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.publication_status_lookup (status, description) VALUES
  ('draft', 'Publication is staged'),
  ('published', 'Publication is available to query resolution'),
  ('superseded', 'Publication was replaced'),
  ('failed', 'Publication validation or deployment failed')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.conversation_status_lookup (status, description) VALUES
  ('active', 'Conversation is active'),
  ('archived', 'Conversation is archived')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.answer_state_lookup (state, description) VALUES
  ('verified', 'Governed answer whose required checks passed'),
  ('qualified', 'Governed answer with a disclosed limitation'),
  ('exploratory', 'Answer from an allowlisted source-specific field'),
  ('clarification', 'One precise user clarification is required'),
  ('unavailable', 'Required data or capability is unavailable')
ON CONFLICT (state) DO NOTHING;

INSERT INTO control_plane.identity_review_status_lookup (status, description) VALUES
  ('proposed', 'A deterministic match awaits review'),
  ('accepted', 'A reviewer accepted the match'),
  ('rejected', 'A reviewer rejected the match'),
  ('superseded', 'A later review replaced this task')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.semantic_inbox_status_lookup (status, description) VALUES
  ('candidate', 'Exploration filed a promotion candidate'),
  ('reviewing', 'Candidate is being reviewed'),
  ('promoted', 'Candidate was added to the governed model'),
  ('rejected', 'Candidate was intentionally not promoted')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.placement_status_lookup (status, description) VALUES
  ('assigned', 'Tenant is assigned to a logical analytical cell'),
  ('moving', 'Tenant placement is being moved'),
  ('unassigned', 'Tenant has no active analytical placement')
ON CONFLICT (status) DO NOTHING;

CREATE TABLE IF NOT EXISTS control_plane.tenants (
  tenant_id text PRIMARY KEY CHECK (control_plane.is_ulid(tenant_id)),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  status text NOT NULL DEFAULT 'active'
    REFERENCES control_plane.tenant_status_lookup(status),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control_plane.memberships (
  tenant_id text NOT NULL,
  membership_id text NOT NULL CHECK (control_plane.is_ulid(membership_id)),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL REFERENCES control_plane.tenant_role_lookup(role),
  status text NOT NULL DEFAULT 'active'
    REFERENCES control_plane.membership_status_lookup(status),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, membership_id),
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_plane.connections (
  tenant_id text NOT NULL,
  connection_id text NOT NULL CHECK (control_plane.is_ulid(connection_id)),
  connector_key text NOT NULL CHECK (connector_key ~ '^[a-z][a-z0-9_]*$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  external_account_reference text,
  status text NOT NULL DEFAULT 'pending'
    REFERENCES control_plane.connection_status_lookup(status),
  auth_health text NOT NULL DEFAULT 'unknown'
    REFERENCES control_plane.connection_auth_health_lookup(status),
  account_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  authorised_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  authorised_at timestamptz,
  last_checked_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(account_metadata) = 'object')
);

COMMENT ON COLUMN control_plane.connections.account_metadata IS
  'Non-secret vendor account discovery metadata only. Credentials and token material are prohibited.';

CREATE UNIQUE INDEX IF NOT EXISTS connections_external_account_unique
  ON control_plane.connections (tenant_id, connector_key, external_account_reference)
  WHERE external_account_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS control_plane.oauth_token_refs (
  tenant_id text NOT NULL,
  token_ref_id text NOT NULL CHECK (control_plane.is_ulid(token_ref_id)),
  connection_id text NOT NULL,
  secret_reference text NOT NULL,
  encryption_key_version text NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  token_expires_at timestamptz,
  last_rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, token_ref_id),
  UNIQUE (tenant_id, connection_id),
  UNIQUE (secret_reference),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE,
  CHECK (length(btrim(secret_reference)) > 0),
  CHECK (length(btrim(encryption_key_version)) > 0)
);

COMMENT ON TABLE control_plane.oauth_token_refs IS
  'Worker-only metadata pointing to envelope-encrypted credential material in the configured secret store. This table must never contain plaintext or encrypted token bodies.';

CREATE TABLE IF NOT EXISTS control_plane.sync_runs (
  tenant_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (control_plane.is_ulid(sync_run_id)),
  connection_id text NOT NULL,
  job_type text NOT NULL REFERENCES control_plane.sync_job_type_lookup(job_type),
  stream text,
  status text NOT NULL DEFAULT 'queued'
    REFERENCES control_plane.sync_run_status_lookup(status),
  attempt_number integer NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  queue_job_reference text,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cursor_start jsonb,
  cursor_end jsonb,
  record_count bigint CHECK (record_count IS NULL OR record_count >= 0),
  quarantine_count bigint CHECK (quarantine_count IS NULL OR quarantine_count >= 0),
  error_code text,
  error_summary text,
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sync_run_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE,
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE IF NOT EXISTS control_plane.stream_cursors (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  stream text NOT NULL CHECK (length(btrim(stream)) > 0),
  cursor_value jsonb,
  source_watermark timestamptz,
  last_successful_sync_at timestamptz,
  backfill_complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, stream),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_plane.readiness (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  domain text NOT NULL CHECK (domain ~ '^[a-z][a-z0-9_]*$'),
  state text NOT NULL DEFAULT 'not_started'
    REFERENCES control_plane.readiness_state_lookup(state),
  progress numeric(5,4) CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
  data_ready_through timestamptz,
  backfill_complete boolean NOT NULL DEFAULT false,
  reason_code text,
  reason_detail text,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, domain),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_plane.dossiers (
  tenant_id text NOT NULL,
  dossier_id text NOT NULL CHECK (control_plane.is_ulid(dossier_id)),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft'
    REFERENCES control_plane.version_status_lookup(status),
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  superseded_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dossier_id),
  UNIQUE (tenant_id, version),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(content) = 'object'),
  CHECK (jsonb_typeof(provenance) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS dossiers_one_published_per_tenant
  ON control_plane.dossiers (tenant_id)
  WHERE status = 'published';

CREATE TABLE IF NOT EXISTS control_plane.tenant_overlays (
  tenant_id text NOT NULL,
  overlay_id text NOT NULL CHECK (control_plane.is_ulid(overlay_id)),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft'
    REFERENCES control_plane.version_status_lookup(status),
  overlay jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_reason text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  superseded_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, overlay_id),
  UNIQUE (tenant_id, version),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(overlay) = 'object'),
  CHECK (length(btrim(change_reason)) > 0)
);

COMMENT ON COLUMN control_plane.tenant_overlays.overlay IS
  'Structured tenant parameters only. SQL, joins, security rules and tenant filters are prohibited.';

CREATE UNIQUE INDEX IF NOT EXISTS tenant_overlays_one_published_per_tenant
  ON control_plane.tenant_overlays (tenant_id)
  WHERE status = 'published';

-- Semantic publications are global, immutable deployment snapshots. Tenant
-- nuance is versioned separately in tenant_overlays; publications are never
-- copied or forked per tenant.
CREATE TABLE IF NOT EXISTS control_plane.semantic_publications (
  publication_id text PRIMARY KEY CHECK (control_plane.is_ulid(publication_id)),
  registry_version text NOT NULL UNIQUE,
  registry_hash text NOT NULL UNIQUE CHECK (registry_hash ~ '^[0-9a-f]{64}$'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  contract_count integer NOT NULL CHECK (contract_count >= 0),
  topic_count integer NOT NULL CHECK (topic_count >= 0),
  pack_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft'
    REFERENCES control_plane.publication_status_lookup(status),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  superseded_at timestamptz,
  CHECK (jsonb_typeof(pack_versions) = 'object'),
  CHECK (jsonb_typeof(manifest) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS semantic_publications_one_published
  ON control_plane.semantic_publications ((status))
  WHERE status = 'published';

CREATE TABLE IF NOT EXISTS control_plane.conversations (
  tenant_id text NOT NULL,
  conversation_id text NOT NULL CHECK (control_plane.is_ulid(conversation_id)),
  title text,
  status text NOT NULL DEFAULT 'active'
    REFERENCES control_plane.conversation_status_lookup(status),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY (tenant_id, conversation_id),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_plane.answer_artifacts (
  tenant_id text NOT NULL,
  answer_artifact_id text NOT NULL CHECK (control_plane.is_ulid(answer_artifact_id)),
  conversation_id text NOT NULL,
  turn_number integer NOT NULL CHECK (turn_number > 0),
  answer_state text NOT NULL REFERENCES control_plane.answer_state_lookup(state),
  question_text text NOT NULL,
  answer_text text NOT NULL,
  interpreted_plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  semantic_ir jsonb,
  compiled_sql text,
  result_digest jsonb,
  validation_outcomes jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  semantic_bundle_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, answer_artifact_id),
  UNIQUE (tenant_id, conversation_id, turn_number),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES control_plane.conversations(tenant_id, conversation_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(interpreted_plan) = 'object'),
  CHECK (semantic_ir IS NULL OR jsonb_typeof(semantic_ir) = 'object'),
  CHECK (result_digest IS NULL OR jsonb_typeof(result_digest) IN ('object', 'array')),
  CHECK (jsonb_typeof(validation_outcomes) = 'array'),
  CHECK (jsonb_typeof(provenance) = 'object')
);

COMMENT ON COLUMN control_plane.answer_artifacts.compiled_sql IS
  'Auditable deterministic compiler output. It is not an agent-facing query path.';

CREATE TABLE IF NOT EXISTS control_plane.answer_execution_events (
  tenant_id text NOT NULL,
  execution_event_id text NOT NULL CHECK (control_plane.is_ulid(execution_event_id)),
  answer_artifact_id text NOT NULL,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*$'),
  event_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, execution_event_id),
  UNIQUE (tenant_id, answer_artifact_id, sequence_number),
  FOREIGN KEY (tenant_id, answer_artifact_id)
    REFERENCES control_plane.answer_artifacts(tenant_id, answer_artifact_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(event_payload) = 'object')
);

CREATE TABLE IF NOT EXISTS control_plane.identity_review_tasks (
  tenant_id text NOT NULL,
  identity_review_task_id text NOT NULL CHECK (control_plane.is_ulid(identity_review_task_id)),
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]*$'),
  status text NOT NULL DEFAULT 'proposed'
    REFERENCES control_plane.identity_review_status_lookup(status),
  confidence_band text NOT NULL CHECK (confidence_band IN ('high', 'medium', 'low')),
  candidate_links jsonb NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, identity_review_task_id),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(candidate_links) = 'array'),
  CHECK (jsonb_typeof(evidence) = 'object'),
  CHECK (resolution IS NULL OR jsonb_typeof(resolution) = 'object')
);

CREATE TABLE IF NOT EXISTS control_plane.semantic_inbox (
  tenant_id text NOT NULL,
  semantic_inbox_item_id text NOT NULL CHECK (control_plane.is_ulid(semantic_inbox_item_id)),
  status text NOT NULL DEFAULT 'candidate'
    REFERENCES control_plane.semantic_inbox_status_lookup(status),
  source_kind text NOT NULL CHECK (source_kind ~ '^[a-z][a-z0-9_]*$'),
  topic_hint text,
  field_reference text NOT NULL,
  sample_question text NOT NULL,
  occurrence_count bigint NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, semantic_inbox_item_id),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(evidence) = 'object'),
  CHECK (last_seen_at >= first_seen_at)
);

CREATE TABLE IF NOT EXISTS control_plane.audit_log (
  tenant_id text NOT NULL,
  audit_id text NOT NULL CHECK (control_plane.is_ulid(audit_id)),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'service', 'operator', 'system')),
  action text NOT NULL CHECK (length(btrim(action)) > 0),
  resource_type text NOT NULL CHECK (length(btrim(resource_type)) > 0),
  resource_id text,
  request_id text,
  audit_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, audit_id),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(audit_metadata) = 'object')
);

COMMENT ON TABLE control_plane.audit_log IS
  'Append-only audit trail. Runtime updates and deletes are rejected; migration-owner remains responsible for any lawful retention operation.';

CREATE TABLE IF NOT EXISTS control_plane.placement_registry (
  tenant_id text PRIMARY KEY,
  logical_cell_key text NOT NULL CHECK (length(btrim(logical_cell_key)) > 0),
  status text NOT NULL DEFAULT 'assigned'
    REFERENCES control_plane.placement_status_lookup(status),
  placement_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(placement_metadata) = 'object')
);

COMMENT ON TABLE control_plane.placement_registry IS
  'Logical analytical cell assignment only. It intentionally does not choose or store a database provider or connection secret.';

-- Tenant-leading operational indexes.

CREATE INDEX IF NOT EXISTS memberships_tenant_role_idx
  ON control_plane.memberships (tenant_id, role, status);
CREATE INDEX IF NOT EXISTS connections_tenant_status_idx
  ON control_plane.connections (tenant_id, status, auth_health);
CREATE INDEX IF NOT EXISTS sync_runs_tenant_connection_status_idx
  ON control_plane.sync_runs (tenant_id, connection_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS readiness_tenant_state_idx
  ON control_plane.readiness (tenant_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS dossiers_tenant_version_idx
  ON control_plane.dossiers (tenant_id, version DESC);
CREATE INDEX IF NOT EXISTS tenant_overlays_tenant_version_idx
  ON control_plane.tenant_overlays (tenant_id, version DESC);
CREATE INDEX IF NOT EXISTS conversations_tenant_updated_idx
  ON control_plane.conversations (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS answer_artifacts_tenant_conversation_idx
  ON control_plane.answer_artifacts (tenant_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS answer_execution_events_order_idx
  ON control_plane.answer_execution_events (tenant_id, answer_artifact_id, sequence_number);
CREATE INDEX IF NOT EXISTS identity_review_tasks_tenant_status_idx
  ON control_plane.identity_review_tasks (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS semantic_inbox_tenant_status_idx
  ON control_plane.semantic_inbox (tenant_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_tenant_time_idx
  ON control_plane.audit_log (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS placement_registry_tenant_status_idx
  ON control_plane.placement_registry (tenant_id, status);

CREATE OR REPLACE FUNCTION control_plane.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_touch_updated_at ON control_plane.tenants;
CREATE TRIGGER tenants_touch_updated_at
  BEFORE UPDATE ON control_plane.tenants
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

DROP TRIGGER IF EXISTS memberships_touch_updated_at ON control_plane.memberships;
CREATE TRIGGER memberships_touch_updated_at
  BEFORE UPDATE ON control_plane.memberships
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

DROP TRIGGER IF EXISTS connections_touch_updated_at ON control_plane.connections;
CREATE TRIGGER connections_touch_updated_at
  BEFORE UPDATE ON control_plane.connections
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

DROP TRIGGER IF EXISTS oauth_token_refs_touch_updated_at ON control_plane.oauth_token_refs;
CREATE TRIGGER oauth_token_refs_touch_updated_at
  BEFORE UPDATE ON control_plane.oauth_token_refs
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

DROP TRIGGER IF EXISTS stream_cursors_touch_updated_at ON control_plane.stream_cursors;
CREATE TRIGGER stream_cursors_touch_updated_at
  BEFORE UPDATE ON control_plane.stream_cursors
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

DROP TRIGGER IF EXISTS readiness_touch_updated_at ON control_plane.readiness;
CREATE TRIGGER readiness_touch_updated_at
  BEFORE UPDATE ON control_plane.readiness
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

DROP TRIGGER IF EXISTS dossiers_touch_updated_at ON control_plane.dossiers;
CREATE TRIGGER dossiers_touch_updated_at
  BEFORE UPDATE ON control_plane.dossiers
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

DROP TRIGGER IF EXISTS tenant_overlays_touch_updated_at ON control_plane.tenant_overlays;
CREATE TRIGGER tenant_overlays_touch_updated_at
  BEFORE UPDATE ON control_plane.tenant_overlays
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

DROP TRIGGER IF EXISTS conversations_touch_updated_at ON control_plane.conversations;
CREATE TRIGGER conversations_touch_updated_at
  BEFORE UPDATE ON control_plane.conversations
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

DROP TRIGGER IF EXISTS identity_review_tasks_touch_updated_at ON control_plane.identity_review_tasks;
CREATE TRIGGER identity_review_tasks_touch_updated_at
  BEFORE UPDATE ON control_plane.identity_review_tasks
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

DROP TRIGGER IF EXISTS semantic_inbox_touch_updated_at ON control_plane.semantic_inbox;
CREATE TRIGGER semantic_inbox_touch_updated_at
  BEFORE UPDATE ON control_plane.semantic_inbox
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

DROP TRIGGER IF EXISTS placement_registry_touch_updated_at ON control_plane.placement_registry;
CREATE TRIGGER placement_registry_touch_updated_at
  BEFORE UPDATE ON control_plane.placement_registry
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

CREATE OR REPLACE FUNCTION control_plane.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'control_plane.audit_log is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_reject_mutation ON control_plane.audit_log;
CREATE TRIGGER audit_log_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.audit_log
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_audit_mutation();

-- SECURITY DEFINER membership helpers are intentionally tiny and own no write
-- path. Because the migration owner owns memberships, these helpers can inspect
-- it without recursive RLS evaluation. auth.uid() is always the identity source;
-- tenant IDs supplied by browser clients are never trusted on their own.

CREATE OR REPLACE FUNCTION control_plane.is_tenant_member(target_tenant_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM control_plane.memberships AS membership
    WHERE membership.tenant_id = target_tenant_id
      AND membership.user_id = auth.uid()
      AND membership.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION control_plane.has_tenant_role(
  target_tenant_id text,
  allowed_roles text[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM control_plane.memberships AS membership
    WHERE membership.tenant_id = target_tenant_id
      AND membership.user_id = auth.uid()
      AND membership.status = 'active'
      AND membership.role = ANY (allowed_roles)
  );
$$;

REVOKE ALL ON FUNCTION control_plane.is_ulid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.touch_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.reject_audit_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.is_tenant_member(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.has_tenant_role(text, text[]) FROM PUBLIC;

-- RLS is enabled on the tenant root and every table that owns tenant data.
-- It is also enabled on global semantic publications so only trusted server
-- roles can publish or resolve registry snapshots directly.

ALTER TABLE control_plane.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.oauth_token_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.stream_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.readiness ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.tenant_overlays ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.answer_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.answer_execution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.identity_review_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.placement_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_members_read ON control_plane.tenants;
CREATE POLICY tenant_members_read ON control_plane.tenants
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS tenant_members_read ON control_plane.memberships;
CREATE POLICY tenant_members_read ON control_plane.memberships
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS tenant_owners_insert ON control_plane.memberships;
CREATE POLICY tenant_owners_insert ON control_plane.memberships
  FOR INSERT TO authenticated
  WITH CHECK (control_plane.has_tenant_role(tenant_id, ARRAY['owner']::text[]));

DROP POLICY IF EXISTS tenant_owners_update ON control_plane.memberships;
CREATE POLICY tenant_owners_update ON control_plane.memberships
  FOR UPDATE TO authenticated
  USING (control_plane.has_tenant_role(tenant_id, ARRAY['owner']::text[]))
  WITH CHECK (control_plane.has_tenant_role(tenant_id, ARRAY['owner']::text[]));

DROP POLICY IF EXISTS tenant_owners_delete ON control_plane.memberships;
CREATE POLICY tenant_owners_delete ON control_plane.memberships
  FOR DELETE TO authenticated
  USING (control_plane.has_tenant_role(tenant_id, ARRAY['owner']::text[]));

DROP POLICY IF EXISTS tenant_members_read ON control_plane.connections;
CREATE POLICY tenant_members_read ON control_plane.connections
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS tenant_connection_admins_insert ON control_plane.connections;
CREATE POLICY tenant_connection_admins_insert ON control_plane.connections
  FOR INSERT TO authenticated
  WITH CHECK (
    control_plane.has_tenant_role(tenant_id, ARRAY['owner', 'manager']::text[])
  );

DROP POLICY IF EXISTS tenant_connection_admins_update ON control_plane.connections;
CREATE POLICY tenant_connection_admins_update ON control_plane.connections
  FOR UPDATE TO authenticated
  USING (
    control_plane.has_tenant_role(tenant_id, ARRAY['owner', 'manager']::text[])
  )
  WITH CHECK (
    control_plane.has_tenant_role(tenant_id, ARRAY['owner', 'manager']::text[])
  );

DROP POLICY IF EXISTS tenant_connection_admins_delete ON control_plane.connections;
CREATE POLICY tenant_connection_admins_delete ON control_plane.connections
  FOR DELETE TO authenticated
  USING (
    control_plane.has_tenant_role(tenant_id, ARRAY['owner', 'manager']::text[])
  );

DROP POLICY IF EXISTS tenant_members_read ON control_plane.sync_runs;
CREATE POLICY tenant_members_read ON control_plane.sync_runs
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS tenant_members_read ON control_plane.stream_cursors;
CREATE POLICY tenant_members_read ON control_plane.stream_cursors
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS tenant_members_read ON control_plane.readiness;
CREATE POLICY tenant_members_read ON control_plane.readiness
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS tenant_members_read ON control_plane.dossiers;
CREATE POLICY tenant_members_read ON control_plane.dossiers
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS tenant_members_read ON control_plane.tenant_overlays;
CREATE POLICY tenant_members_read ON control_plane.tenant_overlays
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS tenant_members_read ON control_plane.conversations;
CREATE POLICY tenant_members_read ON control_plane.conversations
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS tenant_members_insert_own ON control_plane.conversations;
CREATE POLICY tenant_members_insert_own ON control_plane.conversations
  FOR INSERT TO authenticated
  WITH CHECK (
    control_plane.is_tenant_member(tenant_id)
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS tenant_members_update_own ON control_plane.conversations;
CREATE POLICY tenant_members_update_own ON control_plane.conversations
  FOR UPDATE TO authenticated
  USING (
    control_plane.is_tenant_member(tenant_id)
    AND created_by = auth.uid()
  )
  WITH CHECK (
    control_plane.is_tenant_member(tenant_id)
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS tenant_members_delete_own ON control_plane.conversations;
CREATE POLICY tenant_members_delete_own ON control_plane.conversations
  FOR DELETE TO authenticated
  USING (
    control_plane.is_tenant_member(tenant_id)
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS tenant_members_read ON control_plane.answer_artifacts;
CREATE POLICY tenant_members_read ON control_plane.answer_artifacts
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS tenant_members_read ON control_plane.answer_execution_events;
CREATE POLICY tenant_members_read ON control_plane.answer_execution_events
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS tenant_members_read ON control_plane.identity_review_tasks;
CREATE POLICY tenant_members_read ON control_plane.identity_review_tasks
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

-- No authenticated policies exist for oauth_token_refs, semantic_publications,
-- semantic_inbox, audit_log, or placement_registry. Those tables are accessed
-- only by trusted server/operator paths under service_role and remain protected
-- by RLS if privileges are accidentally broadened later.

REVOKE ALL ON SCHEMA control_plane FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA control_plane REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA control_plane REVOKE ALL ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA control_plane TO authenticated;
GRANT EXECUTE ON FUNCTION control_plane.is_ulid(text) TO authenticated;
GRANT EXECUTE ON FUNCTION control_plane.is_tenant_member(text) TO authenticated;
GRANT EXECUTE ON FUNCTION control_plane.has_tenant_role(text, text[]) TO authenticated;

GRANT SELECT ON TABLE
  control_plane.tenant_status_lookup,
  control_plane.tenant_role_lookup,
  control_plane.membership_status_lookup,
  control_plane.connection_status_lookup,
  control_plane.connection_auth_health_lookup,
  control_plane.sync_job_type_lookup,
  control_plane.sync_run_status_lookup,
  control_plane.readiness_state_lookup,
  control_plane.version_status_lookup,
  control_plane.conversation_status_lookup,
  control_plane.answer_state_lookup,
  control_plane.identity_review_status_lookup,
  control_plane.tenants,
  control_plane.memberships,
  control_plane.connections,
  control_plane.sync_runs,
  control_plane.stream_cursors,
  control_plane.readiness,
  control_plane.dossiers,
  control_plane.tenant_overlays,
  control_plane.conversations,
  control_plane.answer_artifacts,
  control_plane.answer_execution_events,
  control_plane.identity_review_tasks
TO authenticated;

GRANT INSERT, UPDATE, DELETE ON TABLE
  control_plane.memberships,
  control_plane.connections,
  control_plane.conversations
TO authenticated;

GRANT USAGE ON SCHEMA control_plane TO service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA control_plane TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA control_plane TO service_role;

COMMIT;
