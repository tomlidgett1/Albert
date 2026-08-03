BEGIN;

-- M2 operational metadata, Supabase-native durable queues, and the operator
-- projections used by /dash/admin. Source records remain outside the control
-- plane; these tables contain only execution, lineage, health, and quarantine
-- metadata.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgmq'
  ) THEN
    RAISE EXCEPTION
      'Albert requires the pgmq extension. Enable Supabase Queues (pgmq) before applying M2.'
      USING ERRCODE = '0A000';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron'
  ) THEN
    RAISE EXCEPTION
      'Albert requires pg_cron. Enable Supabase Cron before applying M2.'
      USING ERRCODE = '0A000';
  END IF;
END;
$$;

ALTER TABLE control_plane.stream_cursors
  ADD COLUMN IF NOT EXISTS cursor_requested_at timestamptz;

CREATE TABLE IF NOT EXISTS control_plane.sync_priority_lookup (
  priority text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.sync_job_request_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.raw_batch_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.webhook_receipt_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.quarantine_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.deletion_request_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.sync_priority_lookup (priority, description) VALUES
  ('high', 'Webhook-signalled and operator-requested incremental work'),
  ('standard', 'Scheduled incrementals and reconciliation work'),
  ('backfill', 'Progressive initial-history work')
ON CONFLICT (priority) DO NOTHING;

INSERT INTO control_plane.sync_job_request_status_lookup (status, description) VALUES
  ('queued', 'Message is available or delayed in pgmq'),
  ('running', 'A worker owns the message visibility window'),
  ('retry_wait', 'The message will become visible after a bounded delay'),
  ('succeeded', 'The worker archived the successfully processed message'),
  ('failed', 'The worker archived the message and emitted a dead-letter record')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.raw_batch_status_lookup (status, description) VALUES
  ('uploaded', 'Immutable compressed raw object and manifest are registered'),
  ('landing', 'Analytical staging transaction is in progress'),
  ('landed', 'Manifest and idempotent staging rows committed analytically'),
  ('quarantined', 'All records in the batch failed validation'),
  ('failed', 'Landing failed and is eligible for replay')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.webhook_receipt_status_lookup (status, description) VALUES
  ('received', 'Signature-verified webhook metadata is durable'),
  ('queued', 'One or more incremental jobs were enqueued'),
  ('duplicate', 'The vendor event was already recorded'),
  ('ignored', 'The verified event does not require a supported stream'),
  ('failed', 'Durable routing failed and requires reconciliation sweep recovery')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.quarantine_status_lookup (status, description) VALUES
  ('open', 'Record awaits replay after a mapping or schema correction'),
  ('replayed', 'A later replay landed the record successfully'),
  ('dismissed', 'An operator deliberately dismissed the record with a reason')
ON CONFLICT (status) DO NOTHING;

INSERT INTO control_plane.deletion_request_status_lookup (status, description) VALUES
  ('queued', 'Deletion is durably requested and awaiting the deletion worker'),
  ('running', 'Deletion is removing data-plane records and raw objects'),
  ('verifying', 'Deletion is verifying every scoped store is empty'),
  ('cancelled', 'Deletion was cancelled before purge because the account was reconnected'),
  ('completed', 'Deletion and verification completed'),
  ('failed', 'Deletion requires operator intervention')
ON CONFLICT (status) DO NOTHING;

CREATE TABLE IF NOT EXISTS control_plane.sync_job_requests (
  tenant_id text NOT NULL,
  job_request_id text NOT NULL CHECK (control_plane.is_ulid(job_request_id)),
  connection_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 240),
  job_type text NOT NULL REFERENCES control_plane.sync_job_type_lookup(job_type),
  priority text NOT NULL REFERENCES control_plane.sync_priority_lookup(priority),
  queue_name text NOT NULL CHECK (
    queue_name IN ('albert_sync_high', 'albert_sync_standard', 'albert_sync_backfill')
  ),
  queue_message_id bigint,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    REFERENCES control_plane.sync_job_request_status_lookup(status),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_claimed_at timestamptz,
  completed_at timestamptz,
  result_metadata jsonb,
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_request_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (queue_name, queue_message_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (result_metadata IS NULL OR jsonb_typeof(result_metadata) = 'object'),
  CHECK (last_error IS NULL OR jsonb_typeof(last_error) = 'object'),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE TABLE IF NOT EXISTS control_plane.sync_job_attempts (
  tenant_id text NOT NULL,
  job_attempt_id text NOT NULL CHECK (control_plane.is_ulid(job_attempt_id)),
  job_request_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL CHECK (length(btrim(worker_id)) BETWEEN 1 AND 160),
  visibility_deadline timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text CHECK (outcome IS NULL OR outcome IN ('succeeded', 'retry', 'failed', 'lost_visibility')),
  error_metadata jsonb,
  PRIMARY KEY (tenant_id, job_attempt_id),
  UNIQUE (tenant_id, job_request_id, attempt_number),
  FOREIGN KEY (tenant_id, job_request_id)
    REFERENCES control_plane.sync_job_requests(tenant_id, job_request_id) ON DELETE CASCADE,
  CHECK (error_metadata IS NULL OR jsonb_typeof(error_metadata) = 'object'),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE IF NOT EXISTS control_plane.sync_job_attempt_outcomes (
  tenant_id text NOT NULL,
  job_attempt_outcome_id text NOT NULL CHECK (control_plane.is_ulid(job_attempt_outcome_id)),
  job_attempt_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'retry', 'failed', 'lost_visibility')),
  error_metadata jsonb,
  finished_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_attempt_outcome_id),
  UNIQUE (tenant_id, job_attempt_id),
  FOREIGN KEY (tenant_id, job_attempt_id)
    REFERENCES control_plane.sync_job_attempts(tenant_id, job_attempt_id) ON DELETE CASCADE,
  CHECK (error_metadata IS NULL OR jsonb_typeof(error_metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS control_plane.raw_batch_manifests (
  tenant_id text NOT NULL,
  batch_id text NOT NULL CHECK (control_plane.is_ulid(batch_id)),
  connection_id text NOT NULL,
  sync_run_id text NOT NULL,
  connector_key text NOT NULL CHECK (connector_key ~ '^[a-z][a-z0-9_-]*$'),
  connector_version text NOT NULL,
  api_version text NOT NULL,
  stream text NOT NULL CHECK (length(btrim(stream)) > 0),
  extracted_at timestamptz NOT NULL,
  cursor_start jsonb,
  cursor_end jsonb,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  schema_fingerprint text NOT NULL CHECK (schema_fingerprint ~ '^[0-9a-f]{64}$'),
  record_count bigint NOT NULL CHECK (record_count >= 0),
  compressed_bytes bigint NOT NULL CHECK (compressed_bytes >= 0),
  object_keys text[] NOT NULL CHECK (cardinality(object_keys) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id),
  UNIQUE (tenant_id, connection_id, content_hash, stream, cursor_start, cursor_end),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sync_run_id)
    REFERENCES control_plane.sync_runs(tenant_id, sync_run_id) ON DELETE CASCADE
);

COMMENT ON TABLE control_plane.raw_batch_manifests IS
  'Immutable operational index for compressed raw objects. The analytical ingestion manifest with the same batch_id is the staging lineage anchor.';

CREATE TABLE IF NOT EXISTS control_plane.raw_batch_landings (
  tenant_id text NOT NULL,
  batch_id text NOT NULL,
  status text NOT NULL DEFAULT 'uploaded'
    REFERENCES control_plane.raw_batch_status_lookup(status),
  staged_record_count bigint CHECK (staged_record_count IS NULL OR staged_record_count >= 0),
  quarantine_count bigint CHECK (quarantine_count IS NULL OR quarantine_count >= 0),
  analytical_committed_at timestamptz,
  last_error jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id),
  FOREIGN KEY (tenant_id, batch_id)
    REFERENCES control_plane.raw_batch_manifests(tenant_id, batch_id) ON DELETE CASCADE,
  CHECK (last_error IS NULL OR jsonb_typeof(last_error) = 'object')
);

CREATE TABLE IF NOT EXISTS control_plane.webhook_receipts (
  tenant_id text NOT NULL,
  webhook_receipt_id text NOT NULL CHECK (control_plane.is_ulid(webhook_receipt_id)),
  connection_id text NOT NULL,
  connector_key text NOT NULL CHECK (connector_key ~ '^[a-z][a-z0-9_-]*$'),
  vendor_event_id text,
  dedupe_key text NOT NULL CHECK (length(btrim(dedupe_key)) > 0),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  signature_verified boolean NOT NULL CHECK (signature_verified),
  safe_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_object_key text,
  status text NOT NULL DEFAULT 'received'
    REFERENCES control_plane.webhook_receipt_status_lookup(status),
  routed_streams text[] NOT NULL DEFAULT ARRAY[]::text[],
  received_at timestamptz NOT NULL,
  queued_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, webhook_receipt_id),
  UNIQUE (tenant_id, connection_id, dedupe_key),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(safe_headers) = 'object')
);

COMMENT ON COLUMN control_plane.webhook_receipts.safe_headers IS
  'Allowlisted non-secret delivery metadata only. Authorization, cookie, and signature header values are prohibited.';

CREATE TABLE IF NOT EXISTS control_plane.quarantine_items (
  tenant_id text NOT NULL,
  quarantine_item_id text NOT NULL CHECK (control_plane.is_ulid(quarantine_item_id)),
  connection_id text NOT NULL,
  sync_run_id text NOT NULL,
  batch_id text NOT NULL,
  stream text NOT NULL CHECK (length(btrim(stream)) > 0),
  source_object_type text NOT NULL CHECK (length(btrim(source_object_type)) > 0),
  source_record_id text,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  raw_object_key text NOT NULL,
  error_code text NOT NULL CHECK (error_code ~ '^[a-z][a-z0-9_.-]*$'),
  error_path text,
  error_summary text NOT NULL CHECK (length(btrim(error_summary)) > 0),
  status text NOT NULL DEFAULT 'open'
    REFERENCES control_plane.quarantine_status_lookup(status),
  replayed_in_sync_run_id text,
  resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, quarantine_item_id),
  UNIQUE NULLS NOT DISTINCT (
    tenant_id, batch_id, source_object_type, source_record_id, error_code, error_path
  ),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sync_run_id)
    REFERENCES control_plane.sync_runs(tenant_id, sync_run_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, batch_id)
    REFERENCES control_plane.raw_batch_manifests(tenant_id, batch_id) ON DELETE CASCADE,
  CHECK ((status = 'open' AND resolved_at IS NULL) OR (status <> 'open' AND resolved_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS control_plane.vendor_rate_budgets (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  budget_key text NOT NULL CHECK (budget_key ~ '^[a-z][a-z0-9_.-]*$'),
  window_started_at timestamptz NOT NULL,
  window_ends_at timestamptz NOT NULL,
  request_limit bigint CHECK (request_limit IS NULL OR request_limit >= 0),
  requests_used bigint NOT NULL DEFAULT 0 CHECK (requests_used >= 0),
  remaining bigint CHECK (remaining IS NULL OR remaining >= 0),
  vendor_reset_at timestamptz,
  observed_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, budget_key, window_started_at),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE,
  CHECK (window_ends_at > window_started_at),
  CHECK (jsonb_typeof(observed_headers) = 'object')
);

CREATE TABLE IF NOT EXISTS control_plane.worker_heartbeats (
  worker_id text PRIMARY KEY CHECK (length(btrim(worker_id)) BETWEEN 1 AND 160),
  service_version text NOT NULL,
  deployment_id text,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  active_job_count integer NOT NULL DEFAULT 0 CHECK (active_job_count >= 0),
  health_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (last_seen_at >= started_at),
  CHECK (jsonb_typeof(health_metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS control_plane.deletion_requests (
  tenant_id text NOT NULL,
  deletion_request_id text NOT NULL CHECK (control_plane.is_ulid(deletion_request_id)),
  connection_id text,
  scope text NOT NULL CHECK (scope IN ('connection', 'tenant')),
  status text NOT NULL DEFAULT 'queued'
    REFERENCES control_plane.deletion_request_status_lookup(status),
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  remote_revocation_status text NOT NULL
    CHECK (remote_revocation_status IN ('succeeded', 'unsupported', 'failed', 'not_applicable')),
  credential_destroyed_at timestamptz NOT NULL,
  purge_due_at timestamptz NOT NULL,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, deletion_request_id),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE RESTRICT,
  CHECK (
    (scope = 'connection' AND connection_id IS NOT NULL)
    OR (scope = 'tenant' AND connection_id IS NULL)
  ),
  CHECK (purge_due_at <= requested_at + interval '30 days'),
  CHECK (jsonb_typeof(progress) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS deletion_requests_one_active_connection
  ON control_plane.deletion_requests (tenant_id, connection_id)
  WHERE scope = 'connection' AND status IN ('queued', 'running', 'verifying');
CREATE INDEX IF NOT EXISTS deletion_requests_due_idx
  ON control_plane.deletion_requests (status, purge_due_at);

ALTER TABLE control_plane.deletion_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_members_read ON control_plane.deletion_requests;
CREATE POLICY tenant_members_read ON control_plane.deletion_requests
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP TRIGGER IF EXISTS deletion_requests_touch_updated_at
  ON control_plane.deletion_requests;
CREATE TRIGGER deletion_requests_touch_updated_at
  BEFORE UPDATE ON control_plane.deletion_requests
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

CREATE INDEX IF NOT EXISTS sync_job_requests_tenant_status_idx
  ON control_plane.sync_job_requests (tenant_id, status, priority, available_at);
CREATE INDEX IF NOT EXISTS sync_job_attempts_tenant_job_idx
  ON control_plane.sync_job_attempts (tenant_id, job_request_id, attempt_number DESC);
CREATE INDEX IF NOT EXISTS raw_batch_manifests_tenant_connection_idx
  ON control_plane.raw_batch_manifests (tenant_id, connection_id, stream, extracted_at DESC);
CREATE INDEX IF NOT EXISTS raw_batch_landings_tenant_status_idx
  ON control_plane.raw_batch_landings (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS webhook_receipts_tenant_connection_idx
  ON control_plane.webhook_receipts (tenant_id, connection_id, received_at DESC);
CREATE INDEX IF NOT EXISTS quarantine_items_tenant_status_idx
  ON control_plane.quarantine_items (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS vendor_rate_budgets_tenant_connection_idx
  ON control_plane.vendor_rate_budgets (tenant_id, connection_id, window_ends_at DESC);

ALTER TABLE control_plane.sync_job_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.sync_job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.sync_job_attempt_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.raw_batch_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.raw_batch_landings ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.webhook_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.quarantine_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.vendor_rate_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.worker_heartbeats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_members_read ON control_plane.sync_job_requests;
CREATE POLICY tenant_members_read ON control_plane.sync_job_requests
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));
DROP POLICY IF EXISTS tenant_members_read ON control_plane.raw_batch_manifests;
CREATE POLICY tenant_members_read ON control_plane.raw_batch_manifests
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));
DROP POLICY IF EXISTS tenant_members_read ON control_plane.raw_batch_landings;
CREATE POLICY tenant_members_read ON control_plane.raw_batch_landings
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

-- Raw manifests and job-attempt history are append-only. The sole mutable
-- attempt field is a monotonically increasing visibility deadline, which is
-- the durable record of a worker renewing its current PGMQ lease.
CREATE OR REPLACE FUNCTION control_plane.reject_raw_manifest_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'control_plane.raw_batch_manifests is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS raw_batch_manifests_reject_mutation
  ON control_plane.raw_batch_manifests;
CREATE TRIGGER raw_batch_manifests_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.raw_batch_manifests
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_raw_manifest_mutation();

CREATE OR REPLACE FUNCTION control_plane.reject_sync_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.job_attempt_id IS NOT DISTINCT FROM OLD.job_attempt_id
     AND NEW.job_request_id IS NOT DISTINCT FROM OLD.job_request_id
     AND NEW.attempt_number IS NOT DISTINCT FROM OLD.attempt_number
     AND NEW.worker_id IS NOT DISTINCT FROM OLD.worker_id
     AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at
     AND NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at
     AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome
     AND NEW.error_metadata IS NOT DISTINCT FROM OLD.error_metadata
     AND NEW.visibility_deadline > OLD.visibility_deadline THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'control_plane.sync_job_attempts is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS sync_job_attempts_reject_mutation
  ON control_plane.sync_job_attempts;
CREATE TRIGGER sync_job_attempts_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.sync_job_attempts
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_sync_attempt_mutation();

DROP TRIGGER IF EXISTS sync_job_requests_touch_updated_at
  ON control_plane.sync_job_requests;
CREATE TRIGGER sync_job_requests_touch_updated_at
  BEFORE UPDATE ON control_plane.sync_job_requests
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();
DROP TRIGGER IF EXISTS raw_batch_landings_touch_updated_at
  ON control_plane.raw_batch_landings;
CREATE TRIGGER raw_batch_landings_touch_updated_at
  BEFORE UPDATE ON control_plane.raw_batch_landings
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();
DROP TRIGGER IF EXISTS webhook_receipts_touch_updated_at
  ON control_plane.webhook_receipts;
CREATE TRIGGER webhook_receipts_touch_updated_at
  BEFORE UPDATE ON control_plane.webhook_receipts
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();
DROP TRIGGER IF EXISTS quarantine_items_touch_updated_at
  ON control_plane.quarantine_items;
CREATE TRIGGER quarantine_items_touch_updated_at
  BEFORE UPDATE ON control_plane.quarantine_items
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();
DROP TRIGGER IF EXISTS vendor_rate_budgets_touch_updated_at
  ON control_plane.vendor_rate_budgets;
CREATE TRIGGER vendor_rate_budgets_touch_updated_at
  BEFORE UPDATE ON control_plane.vendor_rate_budgets
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

DO $$
DECLARE
  queue text;
BEGIN
  FOREACH queue IN ARRAY ARRAY[
    'albert_sync_high',
    'albert_sync_standard',
    'albert_sync_backfill',
    'albert_sync_deadletter'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pgmq.meta WHERE queue_name = queue) THEN
      PERFORM pgmq.create(queue);
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_pgmq_ready()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
DECLARE
  missing text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgmq'
  ) THEN
    RAISE EXCEPTION 'pgmq extension is not installed' USING ERRCODE = '0A000';
  END IF;

  SELECT array_agg(required.queue_name ORDER BY required.queue_name)
    INTO missing
  FROM unnest(ARRAY[
    'albert_sync_high',
    'albert_sync_standard',
    'albert_sync_backfill',
    'albert_sync_deadletter'
  ]) AS required(queue_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pgmq.meta AS queue WHERE queue.queue_name = required.queue_name
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'required Albert pgmq queues are missing: %', array_to_string(missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.enqueue_sync_job(
  p_payload jsonb,
  p_priority text,
  p_idempotency_key text,
  p_delay_seconds integer DEFAULT 0
)
RETURNS TABLE (
  job_request_id text,
  queue_message_id bigint,
  queue_name text,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
DECLARE
  payload_tenant text := p_payload ->> 'tenantId';
  payload_connection text := p_payload ->> 'connectionId';
  payload_job_type text := p_payload ->> 'type';
  selected_queue text;
  generated_job_id text;
  generated_message_id bigint;
BEGIN
  PERFORM control_plane.assert_pgmq_ready();
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR payload_tenant IS NULL OR payload_connection IS NULL
     OR payload_job_type NOT IN ('InitialBackfill', 'IncrementalSync', 'ReconciliationSweep')
     OR p_priority NOT IN ('high', 'standard', 'backfill')
     OR length(btrim(p_idempotency_key)) NOT BETWEEN 8 AND 240
     OR p_delay_seconds NOT BETWEEN 0 AND 604800 THEN
    RAISE EXCEPTION 'sync job request is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM control_plane.connections AS connection
  WHERE connection.tenant_id = payload_tenant
    AND connection.connection_id = payload_connection
    AND connection.status <> 'disconnected';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active connection was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT request.job_request_id, request.queue_message_id, request.queue_name, false
    INTO job_request_id, queue_message_id, queue_name, created
  FROM control_plane.sync_job_requests AS request
  WHERE request.tenant_id = payload_tenant
    AND request.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN NEXT;
    RETURN;
  END IF;

  selected_queue := CASE p_priority
    WHEN 'high' THEN 'albert_sync_high'
    WHEN 'standard' THEN 'albert_sync_standard'
    ELSE 'albert_sync_backfill'
  END;
  generated_job_id := control_plane.generate_ulid();

  SELECT send INTO generated_message_id
  FROM pgmq.send(
    selected_queue,
    p_payload || jsonb_build_object('jobRequestId', generated_job_id),
    p_delay_seconds
  );

  INSERT INTO control_plane.sync_job_requests (
    tenant_id, job_request_id, connection_id, idempotency_key, job_type,
    priority, queue_name, queue_message_id, payload, status, available_at
  ) VALUES (
    payload_tenant, generated_job_id, payload_connection, p_idempotency_key,
    payload_job_type, p_priority, selected_queue, generated_message_id,
    p_payload || jsonb_build_object('jobRequestId', generated_job_id),
    'queued', now() + make_interval(secs => p_delay_seconds)
  );

  job_request_id := generated_job_id;
  queue_message_id := generated_message_id;
  queue_name := selected_queue;
  created := true;
  RETURN NEXT;
EXCEPTION
  WHEN unique_violation THEN
    SELECT request.job_request_id, request.queue_message_id, request.queue_name, false
      INTO job_request_id, queue_message_id, queue_name, created
    FROM control_plane.sync_job_requests AS request
    WHERE request.tenant_id = payload_tenant
      AND request.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN NEXT;
      RETURN;
    END IF;
    RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.claim_sync_jobs(
  p_queue_name text,
  p_worker_id text,
  p_visibility_timeout_seconds integer DEFAULT 300,
  p_quantity integer DEFAULT 1
)
RETURNS TABLE (
  message_id bigint,
  read_count bigint,
  enqueued_at timestamptz,
  visibility_deadline timestamptz,
  payload jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
DECLARE
  message record;
  request_tenant text;
  request_id text;
BEGIN
  PERFORM control_plane.assert_pgmq_ready();
  IF p_queue_name NOT IN ('albert_sync_high', 'albert_sync_standard', 'albert_sync_backfill')
     OR length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_visibility_timeout_seconds NOT BETWEEN 30 AND 3600
     OR p_quantity NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'queue claim request is invalid' USING ERRCODE = '22023';
  END IF;

  FOR message IN
    SELECT * FROM pgmq.read(p_queue_name, p_visibility_timeout_seconds, p_quantity)
  LOOP
    request_id := message.message ->> 'jobRequestId';
    SELECT request.tenant_id INTO request_tenant
    FROM control_plane.sync_job_requests AS request
    WHERE request.queue_name = p_queue_name
      AND request.queue_message_id = message.msg_id
      AND request.job_request_id = request_id
    FOR UPDATE;

    IF request_tenant IS NULL THEN
      PERFORM pgmq.archive(p_queue_name, message.msg_id);
      PERFORM pgmq.send(
        'albert_sync_deadletter',
        jsonb_build_object(
          'reason', 'orphaned_queue_message',
          'sourceQueue', p_queue_name,
          'sourceMessageId', message.msg_id,
          'payload', message.message
        )
      );
      CONTINUE;
    END IF;

    UPDATE control_plane.sync_job_requests
    SET status = 'running', last_claimed_at = now(), last_error = NULL
    WHERE tenant_id = request_tenant AND job_request_id = request_id;

    INSERT INTO control_plane.sync_job_attempts (
      tenant_id, job_attempt_id, job_request_id, attempt_number,
      worker_id, visibility_deadline
    ) VALUES (
      request_tenant,
      control_plane.generate_ulid(),
      request_id,
      message.read_ct::integer,
      p_worker_id,
      message.vt
    );

    message_id := message.msg_id;
    read_count := message.read_ct;
    enqueued_at := message.enqueued_at;
    visibility_deadline := message.vt;
    payload := message.message;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.require_active_sync_job_lease(
  p_queue_name text,
  p_message_id bigint,
  p_job_request_id text,
  p_worker_id text,
  p_read_count integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  request_tenant text;
BEGIN
  IF p_queue_name NOT IN ('albert_sync_high', 'albert_sync_standard', 'albert_sync_backfill')
     OR length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_read_count < 1 THEN
    RAISE EXCEPTION 'sync job lease identity is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT request.tenant_id INTO request_tenant
  FROM control_plane.sync_job_requests AS request
  JOIN control_plane.sync_job_attempts AS attempt
    ON attempt.tenant_id = request.tenant_id
   AND attempt.job_request_id = request.job_request_id
   AND attempt.attempt_number = p_read_count
   AND attempt.worker_id = p_worker_id
  WHERE request.job_request_id = p_job_request_id
    AND request.queue_name = p_queue_name
    AND request.queue_message_id = p_message_id
    AND request.status = 'running'
    AND attempt.visibility_deadline > clock_timestamp()
    AND NOT EXISTS (
      SELECT 1
      FROM control_plane.sync_job_attempts AS later
      WHERE later.tenant_id = request.tenant_id
        AND later.job_request_id = request.job_request_id
        AND later.attempt_number > attempt.attempt_number
    )
    AND NOT EXISTS (
      SELECT 1
      FROM control_plane.sync_job_attempt_outcomes AS outcome
      WHERE outcome.tenant_id = attempt.tenant_id
        AND outcome.job_attempt_id = attempt.job_attempt_id
    )
  FOR UPDATE OF request, attempt;

  IF request_tenant IS NULL THEN
    RAISE EXCEPTION 'sync job lease is no longer active' USING ERRCODE = '55000';
  END IF;
  RETURN request_tenant;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_sync_job(
  p_queue_name text,
  p_message_id bigint,
  p_job_request_id text,
  p_worker_id text,
  p_read_count integer,
  p_result jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
DECLARE
  request_tenant text;
BEGIN
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' THEN
    RAISE EXCEPTION 'job completion is invalid' USING ERRCODE = '22023';
  END IF;
  request_tenant := control_plane.require_active_sync_job_lease(
    p_queue_name, p_message_id, p_job_request_id, p_worker_id, p_read_count
  );

  IF NOT pgmq.archive(p_queue_name, p_message_id) THEN
    RAISE EXCEPTION 'queue message could not be archived' USING ERRCODE = '55000';
  END IF;
  INSERT INTO control_plane.sync_job_attempt_outcomes (
    tenant_id, job_attempt_outcome_id, job_attempt_id, outcome
  )
  SELECT request_tenant, control_plane.generate_ulid(), attempt.job_attempt_id, 'succeeded'
  FROM control_plane.sync_job_attempts AS attempt
  WHERE attempt.tenant_id = request_tenant
    AND attempt.job_request_id = p_job_request_id
    AND attempt.attempt_number = p_read_count
    AND attempt.worker_id = p_worker_id
  ON CONFLICT (tenant_id, job_attempt_id) DO NOTHING;
  UPDATE control_plane.sync_job_requests
  SET status = 'succeeded', completed_at = now(), result_metadata = p_result
  WHERE tenant_id = request_tenant AND job_request_id = p_job_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.extend_sync_job_visibility(
  p_queue_name text,
  p_message_id bigint,
  p_job_request_id text,
  p_worker_id text,
  p_read_count integer,
  p_visibility_timeout_seconds integer
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
DECLARE
  request_tenant text;
  next_deadline timestamptz;
BEGIN
  IF p_visibility_timeout_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'job visibility extension is invalid' USING ERRCODE = '22023';
  END IF;
  request_tenant := control_plane.require_active_sync_job_lease(
    p_queue_name, p_message_id, p_job_request_id, p_worker_id, p_read_count
  );

  PERFORM pgmq.set_vt(p_queue_name, p_message_id, p_visibility_timeout_seconds);
  next_deadline := clock_timestamp() + make_interval(secs => p_visibility_timeout_seconds);
  UPDATE control_plane.sync_job_attempts AS attempt
  SET visibility_deadline = next_deadline
  WHERE attempt.tenant_id = request_tenant
    AND attempt.job_request_id = p_job_request_id
    AND attempt.attempt_number = p_read_count
    AND attempt.worker_id = p_worker_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync job lease attempt was not found' USING ERRCODE = '55000';
  END IF;
  RETURN next_deadline;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.retry_or_fail_sync_job(
  p_queue_name text,
  p_message_id bigint,
  p_job_request_id text,
  p_worker_id text,
  p_read_count integer,
  p_error jsonb,
  p_retry_delay_seconds integer,
  p_max_attempts integer DEFAULT 8
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
DECLARE
  request_row control_plane.sync_job_requests%ROWTYPE;
  attempt_count integer;
BEGIN
  IF p_error IS NULL OR jsonb_typeof(p_error) <> 'object'
     OR p_retry_delay_seconds NOT BETWEEN 1 AND 604800
     OR p_max_attempts NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'job failure input is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM control_plane.require_active_sync_job_lease(
    p_queue_name, p_message_id, p_job_request_id, p_worker_id, p_read_count
  );
  SELECT * INTO STRICT request_row
  FROM control_plane.sync_job_requests AS request
  WHERE request.job_request_id = p_job_request_id
    AND request.queue_name = p_queue_name
    AND request.queue_message_id = p_message_id
  FOR UPDATE;
  attempt_count := p_read_count;

  IF attempt_count < p_max_attempts THEN
    PERFORM pgmq.set_vt(p_queue_name, p_message_id, p_retry_delay_seconds);
    UPDATE control_plane.sync_job_requests
    SET status = 'retry_wait',
        available_at = now() + make_interval(secs => p_retry_delay_seconds),
        last_error = p_error
    WHERE tenant_id = request_row.tenant_id AND job_request_id = p_job_request_id;
    INSERT INTO control_plane.sync_job_attempt_outcomes (
      tenant_id, job_attempt_outcome_id, job_attempt_id, outcome, error_metadata
    )
    SELECT request_row.tenant_id, control_plane.generate_ulid(),
      attempt.job_attempt_id, 'retry', p_error
    FROM control_plane.sync_job_attempts AS attempt
    WHERE attempt.tenant_id = request_row.tenant_id
      AND attempt.job_request_id = p_job_request_id
      AND attempt.attempt_number = p_read_count
      AND attempt.worker_id = p_worker_id
    ON CONFLICT (tenant_id, job_attempt_id) DO NOTHING;
    RETURN 'retry_wait';
  END IF;

  IF NOT pgmq.archive(p_queue_name, p_message_id) THEN
    RAISE EXCEPTION 'queue message could not be archived' USING ERRCODE = '55000';
  END IF;
  PERFORM pgmq.send(
    'albert_sync_deadletter',
    jsonb_build_object(
      'jobRequestId', p_job_request_id,
      'tenantId', request_row.tenant_id,
      'connectionId', request_row.connection_id,
      'sourceQueue', p_queue_name,
      'sourceMessageId', p_message_id,
      'attempts', attempt_count,
      'error', p_error,
      'payload', request_row.payload,
      'failedAt', now()
    )
  );
  UPDATE control_plane.sync_job_requests
  SET status = 'failed', completed_at = now(), last_error = p_error
  WHERE tenant_id = request_row.tenant_id AND job_request_id = p_job_request_id;
  INSERT INTO control_plane.sync_job_attempt_outcomes (
    tenant_id, job_attempt_outcome_id, job_attempt_id, outcome, error_metadata
  )
  SELECT request_row.tenant_id, control_plane.generate_ulid(),
    attempt.job_attempt_id, 'failed', p_error
  FROM control_plane.sync_job_attempts AS attempt
  WHERE attempt.tenant_id = request_row.tenant_id
    AND attempt.job_request_id = p_job_request_id
    AND attempt.attempt_number = p_read_count
    AND attempt.worker_id = p_worker_id
  ON CONFLICT (tenant_id, job_attempt_id) DO NOTHING;
  RETURN 'failed';
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.heartbeat_worker(
  p_worker_id text,
  p_service_version text,
  p_deployment_id text,
  p_started_at timestamptz,
  p_active_job_count integer,
  p_health_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_active_job_count < 0
     OR p_health_metadata IS NULL OR jsonb_typeof(p_health_metadata) <> 'object' THEN
    RAISE EXCEPTION 'worker heartbeat is invalid' USING ERRCODE = '22023';
  END IF;
  INSERT INTO control_plane.worker_heartbeats (
    worker_id, service_version, deployment_id, started_at, last_seen_at,
    active_job_count, health_metadata
  ) VALUES (
    p_worker_id, p_service_version, p_deployment_id, p_started_at, now(),
    p_active_job_count, p_health_metadata
  )
  ON CONFLICT (worker_id) DO UPDATE SET
    service_version = EXCLUDED.service_version,
    deployment_id = EXCLUDED.deployment_id,
    started_at = EXCLUDED.started_at,
    last_seen_at = EXCLUDED.last_seen_at,
    active_job_count = EXCLUDED.active_job_count,
    health_metadata = EXCLUDED.health_metadata;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.sync_queue_metrics()
RETURNS TABLE (
  queue_name text,
  queue_length bigint,
  oldest_msg_age_sec integer,
  total_messages bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
  SELECT metric.queue_name,
         metric.queue_length::bigint,
         metric.oldest_msg_age_sec::integer,
         metric.total_messages::bigint
  FROM pgmq.metrics_all() AS metric
  WHERE metric.queue_name IN (
    'albert_sync_high', 'albert_sync_standard', 'albert_sync_backfill'
  );
$$;

CREATE OR REPLACE FUNCTION control_plane.enqueue_due_incremental_syncs(
  p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate record;
  interval_seconds integer;
  bucket bigint;
  enqueued_count integer := 0;
BEGIN
  FOR candidate IN
    SELECT connection.tenant_id, connection.connection_id,
           connection.connector_key, connection.external_account_reference,
           cursor.stream, cursor.cursor_value, cursor.last_successful_sync_at
    FROM control_plane.connections AS connection
    JOIN control_plane.oauth_token_refs AS token
      ON token.tenant_id = connection.tenant_id
     AND token.connection_id = connection.connection_id
    JOIN control_plane.stream_cursors AS cursor
      ON cursor.tenant_id = connection.tenant_id
     AND cursor.connection_id = connection.connection_id
    WHERE connection.status IN ('connected', 'degraded')
      AND connection.external_account_reference IS NOT NULL
      AND cursor.cursor_value IS NOT NULL
      AND cursor.cursor_value ->> 'value' IS NOT NULL
    ORDER BY connection.tenant_id, connection.connection_id, cursor.stream
  LOOP
    interval_seconds := CASE candidate.connector_key
      WHEN 'lightspeed-r' THEN 900
      WHEN 'deputy' THEN 900
      WHEN 'xero' THEN 3600
      ELSE 3600
    END;
    IF candidate.last_successful_sync_at IS NOT NULL
       AND candidate.last_successful_sync_at > p_now - make_interval(secs => interval_seconds) THEN
      CONTINUE;
    END IF;
    bucket := floor(extract(epoch FROM p_now) / interval_seconds)::bigint;
    PERFORM control_plane.enqueue_sync_job(
      jsonb_build_object(
        'schemaVersion', 1,
        'type', 'IncrementalSync',
        'tenantId', candidate.tenant_id,
        'connectionId', candidate.connection_id,
        'connectorId', candidate.connector_key,
        'externalAccountReference', candidate.external_account_reference,
        'syncRunId', control_plane.generate_ulid(),
        'batchId', control_plane.generate_ulid(),
        'requestedAt', p_now,
        'stream', candidate.stream,
        'cursor', candidate.cursor_value,
        'reason', 'schedule'
      ),
      'standard',
      'scheduled:' || candidate.connection_id || ':' || candidate.stream || ':' || bucket::text,
      0
    );
    enqueued_count := enqueued_count + 1;
  END LOOP;
  RETURN enqueued_count;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.enqueue_nightly_reconciliation_sweeps(
  p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate record;
  enqueued_count integer := 0;
  schedule_date text := to_char(p_now AT TIME ZONE 'UTC', 'YYYY-MM-DD');
BEGIN
  FOR candidate IN
    SELECT connection.tenant_id, connection.connection_id,
           connection.connector_key, connection.external_account_reference,
           cursor.stream
    FROM control_plane.connections AS connection
    JOIN control_plane.oauth_token_refs AS token
      ON token.tenant_id = connection.tenant_id
     AND token.connection_id = connection.connection_id
    JOIN control_plane.stream_cursors AS cursor
      ON cursor.tenant_id = connection.tenant_id
     AND cursor.connection_id = connection.connection_id
    WHERE connection.status IN ('connected', 'degraded')
      AND connection.external_account_reference IS NOT NULL
    ORDER BY connection.tenant_id, connection.connection_id, cursor.stream
  LOOP
    PERFORM control_plane.enqueue_sync_job(
      jsonb_build_object(
        'schemaVersion', 1,
        'type', 'ReconciliationSweep',
        'tenantId', candidate.tenant_id,
        'connectionId', candidate.connection_id,
        'connectorId', candidate.connector_key,
        'externalAccountReference', candidate.external_account_reference,
        'syncRunId', control_plane.generate_ulid(),
        'batchId', control_plane.generate_ulid(),
        'requestedAt', p_now,
        'stream', candidate.stream,
        'lookbackFrom', p_now - interval '7 days',
        'lookbackTo', p_now
      ),
      'standard',
      'reconcile:' || candidate.connection_id || ':' || candidate.stream || ':' || schedule_date,
      0
    );
    enqueued_count := enqueued_count + 1;
  END LOOP;
  RETURN enqueued_count;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.expire_oauth_sessions(
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  session record;
  expired_count integer := 0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'OAuth expiry batch limit is invalid' USING ERRCODE = '22023';
  END IF;
  FOR session IN
    SELECT tenant_id, oauth_session_id, provider
    FROM control_plane.oauth_sessions
    WHERE status IN ('pending', 'selecting_account', 'exchanging')
      AND expires_at <= now()
    ORDER BY expires_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE control_plane.oauth_sessions
    SET status = 'expired', failure_code = 'session_expired',
        pkce_verifier_secret_reference = NULL
    WHERE tenant_id = session.tenant_id
      AND oauth_session_id = session.oauth_session_id;
    DELETE FROM control_plane.oauth_session_secret_envelopes
    WHERE tenant_id = session.tenant_id
      AND oauth_session_id = session.oauth_session_id;
    INSERT INTO control_plane.audit_log (
      tenant_id, audit_id, actor_type, action, resource_type, resource_id,
      audit_metadata
    ) VALUES (
      session.tenant_id, control_plane.generate_ulid(), 'service',
      'oauth.session_expired', 'oauth_session', session.oauth_session_id,
      jsonb_build_object('provider', session.provider)
    );
    expired_count := expired_count + 1;
  END LOOP;
  RETURN expired_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_create_connection(
  p_connector_key text,
  p_display_name text
)
RETURNS TABLE (connection_id text, connector_key text, display_name text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := auth.uid();
  generated_connection text := control_plane.generate_ulid();
BEGIN
  IF NOT control_plane.has_tenant_role(selected_tenant, ARRAY['owner', 'manager']::text[]) THEN
    RAISE EXCEPTION 'owner or manager role required' USING ERRCODE = '42501';
  END IF;
  IF p_connector_key NOT IN ('lightspeed-r', 'xero', 'deputy')
     OR length(btrim(p_display_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'connection input is invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.connections (
    tenant_id, connection_id, connector_key, display_name, status,
    auth_health, authorised_by
  ) VALUES (
    selected_tenant, generated_connection, p_connector_key, btrim(p_display_name),
    'pending', 'unknown', actor
  );
  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'connection.created', 'connection', generated_connection,
    jsonb_build_object('connector_key', p_connector_key)
  );
  RETURN QUERY SELECT generated_connection, p_connector_key, btrim(p_display_name), 'pending'::text;
END;
$$;

-- The administrator bootstrap schedules these fixed commands as the postgres
-- login. Scheduling them directly here would bind execution to the NOLOGIN
-- migration owner and silently create jobs that cannot open worker sessions.
SELECT extensions.albert_install_foundation_cron_jobs();

CREATE OR REPLACE FUNCTION public.albert_rename_connection(
  p_connection_id text,
  p_display_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := auth.uid();
BEGIN
  IF NOT control_plane.has_tenant_role(selected_tenant, ARRAY['owner', 'manager']::text[]) THEN
    RAISE EXCEPTION 'owner or manager role required' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(p_display_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'connection display name is invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.connections
  SET display_name = btrim(p_display_name)
  WHERE tenant_id = selected_tenant AND connection_id = p_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection was not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'connection.renamed', 'connection', p_connection_id,
    jsonb_build_object('display_name', btrim(p_display_name))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_operator_fleet()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
DECLARE
  actor uuid := auth.uid();
  result jsonb;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO control_plane.operator_audit_log (
    operator_audit_id, actor_user_id, action, request_metadata
  ) VALUES (
    control_plane.generate_ulid(), actor, 'operator.fleet_read', '{}'::jsonb
  );

  SELECT jsonb_build_object(
    'generated_at', now(),
    'queues', coalesce((
      SELECT jsonb_agg(to_jsonb(metric) ORDER BY metric.queue_name)
      FROM pgmq.metrics_all() AS metric
      WHERE metric.queue_name LIKE 'albert_sync_%'
    ), '[]'::jsonb),
    'workers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'worker_id', worker.worker_id,
        'service_version', worker.service_version,
        'last_seen_at', worker.last_seen_at,
        'active_job_count', worker.active_job_count,
        'healthy', worker.last_seen_at > now() - interval '2 minutes'
      ) ORDER BY worker.worker_id)
      FROM control_plane.worker_heartbeats AS worker
    ), '[]'::jsonb),
    'connections', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'tenant_id', tenant.tenant_id,
        'tenant_name', tenant.display_name,
        'connection_id', connection.connection_id,
        'connector_key', connection.connector_key,
        'display_name', connection.display_name,
        'status', connection.status,
        'auth_health', connection.auth_health,
        'last_successful_sync_at', (
          SELECT max(cursor.last_successful_sync_at)
          FROM control_plane.stream_cursors AS cursor
          WHERE cursor.tenant_id = connection.tenant_id
            AND cursor.connection_id = connection.connection_id
        ),
        'readiness', coalesce((
          SELECT jsonb_object_agg(readiness.domain, jsonb_build_object(
            'state', readiness.state,
            'progress', readiness.progress,
            'ready_through', readiness.data_ready_through,
            'reason_code', readiness.reason_code
          ))
          FROM control_plane.readiness AS readiness
          WHERE readiness.tenant_id = connection.tenant_id
            AND readiness.connection_id = connection.connection_id
        ), '{}'::jsonb),
        'open_quarantine_count', (
          SELECT count(*)
          FROM control_plane.quarantine_items AS quarantine
          WHERE quarantine.tenant_id = connection.tenant_id
            AND quarantine.connection_id = connection.connection_id
            AND quarantine.status = 'open'
        ),
        'last_webhook_received_at', (
          SELECT max(webhook.received_at)
          FROM control_plane.webhook_receipts AS webhook
          WHERE webhook.tenant_id = connection.tenant_id
            AND webhook.connection_id = connection.connection_id
        )
      ) ORDER BY
        CASE WHEN connection.status IN ('blocked', 'degraded') THEN 0 ELSE 1 END,
        tenant.display_name, connection.connector_key)
      FROM control_plane.connections AS connection
      JOIN control_plane.tenants AS tenant ON tenant.tenant_id = connection.tenant_id
      WHERE tenant.status <> 'deleted'
    ), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_operator_pipeline(p_tenant_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  result jsonb;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control_plane.tenants WHERE tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant was not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO control_plane.operator_audit_log (
    operator_audit_id, actor_user_id, action, target_tenant_id, request_metadata
  ) VALUES (
    control_plane.generate_ulid(), actor, 'operator.pipeline_read', p_tenant_id, '{}'::jsonb
  );

  SELECT jsonb_build_object(
    'tenant', (
      SELECT jsonb_build_object('tenant_id', tenant.tenant_id, 'name', tenant.display_name)
      FROM control_plane.tenants AS tenant WHERE tenant.tenant_id = p_tenant_id
    ),
    'connections', coalesce((SELECT jsonb_agg(to_jsonb(connection) - 'account_metadata')
      FROM control_plane.connections AS connection WHERE connection.tenant_id = p_tenant_id), '[]'::jsonb),
    'cursors', coalesce((SELECT jsonb_agg(to_jsonb(cursor) ORDER BY cursor.connection_id, cursor.stream)
      FROM control_plane.stream_cursors AS cursor WHERE cursor.tenant_id = p_tenant_id), '[]'::jsonb),
    'readiness', coalesce((SELECT jsonb_agg(to_jsonb(readiness) ORDER BY readiness.connection_id, readiness.domain)
      FROM control_plane.readiness AS readiness WHERE readiness.tenant_id = p_tenant_id), '[]'::jsonb),
    'recent_runs', coalesce((SELECT jsonb_agg(to_jsonb(run) ORDER BY run.created_at DESC)
      FROM (SELECT * FROM control_plane.sync_runs WHERE tenant_id = p_tenant_id ORDER BY created_at DESC LIMIT 100) AS run), '[]'::jsonb),
    'jobs', coalesce((SELECT jsonb_agg((to_jsonb(job) - 'payload' - 'last_error') ORDER BY job.created_at DESC)
      FROM (SELECT * FROM control_plane.sync_job_requests WHERE tenant_id = p_tenant_id ORDER BY created_at DESC LIMIT 100) AS job), '[]'::jsonb),
    'raw_batches', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'batch_id', manifest.batch_id,
      'connection_id', manifest.connection_id,
      'stream', manifest.stream,
      'extracted_at', manifest.extracted_at,
      'record_count', manifest.record_count,
      'compressed_bytes', manifest.compressed_bytes,
      'object_keys', manifest.object_keys,
      'landing_status', landing.status,
      'staged_record_count', landing.staged_record_count,
      'quarantine_count', landing.quarantine_count
    ) ORDER BY manifest.extracted_at DESC)
      FROM control_plane.raw_batch_manifests AS manifest
      JOIN control_plane.raw_batch_landings AS landing
        ON landing.tenant_id = manifest.tenant_id AND landing.batch_id = manifest.batch_id
      WHERE manifest.tenant_id = p_tenant_id), '[]'::jsonb),
    'quarantine', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'quarantine_item_id', quarantine.quarantine_item_id,
      'connection_id', quarantine.connection_id,
      'stream', quarantine.stream,
      'source_object_type', quarantine.source_object_type,
      'error_code', quarantine.error_code,
      'error_path', quarantine.error_path,
      'status', quarantine.status,
      'created_at', quarantine.created_at
    ) ORDER BY quarantine.created_at DESC)
      FROM control_plane.quarantine_items AS quarantine
      WHERE quarantine.tenant_id = p_tenant_id), '[]'::jsonb),
    'vendor_budgets', coalesce((SELECT jsonb_agg(to_jsonb(budget) - 'observed_headers' ORDER BY budget.window_ends_at DESC)
      FROM control_plane.vendor_rate_budgets AS budget WHERE budget.tenant_id = p_tenant_id), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;

-- Create the private raw bucket through a migration. No browser policies are
-- created; workers use service credentials and always upload with upsert=false.
INSERT INTO storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) VALUES (
  'raw-payloads',
  'raw-payloads',
  false,
  52428800,
  ARRAY['application/gzip', 'application/x-gzip']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

REVOKE ALL ON TABLE
  control_plane.sync_job_requests,
  control_plane.sync_job_attempts,
  control_plane.sync_job_attempt_outcomes,
  control_plane.raw_batch_manifests,
  control_plane.raw_batch_landings,
  control_plane.webhook_receipts,
  control_plane.quarantine_items,
  control_plane.vendor_rate_budgets,
  control_plane.worker_heartbeats,
  control_plane.deletion_requests
FROM PUBLIC, anon;

GRANT ALL PRIVILEGES ON TABLE
  control_plane.sync_job_requests,
  control_plane.sync_job_attempts,
  control_plane.sync_job_attempt_outcomes,
  control_plane.raw_batch_manifests,
  control_plane.raw_batch_landings,
  control_plane.webhook_receipts,
  control_plane.quarantine_items,
  control_plane.vendor_rate_budgets,
  control_plane.worker_heartbeats,
  control_plane.deletion_requests
TO service_role;

GRANT SELECT ON TABLE
  control_plane.sync_job_requests,
  control_plane.raw_batch_manifests,
  control_plane.raw_batch_landings,
  control_plane.deletion_requests
TO authenticated;

REVOKE ALL ON FUNCTION control_plane.assert_pgmq_ready() FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.enqueue_sync_job(jsonb, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.claim_sync_jobs(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.require_active_sync_job_lease(text, bigint, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.complete_sync_job(text, bigint, text, text, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.extend_sync_job_visibility(text, bigint, text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.retry_or_fail_sync_job(text, bigint, text, text, integer, jsonb, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.heartbeat_worker(text, text, text, timestamptz, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.sync_queue_metrics() FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.enqueue_due_incremental_syncs(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.enqueue_nightly_reconciliation_sweeps(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.expire_oauth_sessions(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION control_plane.assert_pgmq_ready() TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.enqueue_sync_job(jsonb, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.claim_sync_jobs(text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.complete_sync_job(text, bigint, text, text, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.extend_sync_job_visibility(text, bigint, text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.retry_or_fail_sync_job(text, bigint, text, text, integer, jsonb, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.heartbeat_worker(text, text, text, timestamptz, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.sync_queue_metrics() TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.enqueue_due_incremental_syncs(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.enqueue_nightly_reconciliation_sweeps(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.expire_oauth_sessions(integer) TO service_role;

REVOKE ALL ON FUNCTION public.albert_create_connection(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_rename_connection(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_create_connection(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_rename_connection(text, text) TO authenticated;

COMMIT;
