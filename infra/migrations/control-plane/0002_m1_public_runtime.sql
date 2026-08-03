BEGIN;

-- M1 public runtime API and server-only credential/turn persistence.
--
-- Supabase PostgREST exposes the public schema by default. These narrow,
-- SECURITY DEFINER functions are the only browser-facing bridge into the
-- control_plane schema; exposing control_plane itself through the Data API is
-- neither required nor permitted. Every authenticated function derives the
-- actor from auth.uid(), uses a fixed search_path, and rechecks membership.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- The pack id is lightspeed-r. The original M1 expression accepted only
-- underscores, which made the locked connector id impossible to persist.
ALTER TABLE control_plane.connections
  DROP CONSTRAINT IF EXISTS connections_connector_key_check;
ALTER TABLE control_plane.connections
  ADD CONSTRAINT connections_connector_key_check
  CHECK (connector_key ~ '^[a-z][a-z0-9_-]*$');

CREATE OR REPLACE FUNCTION control_plane.generate_ulid()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, extensions
AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  timestamp_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  randomness bytea := extensions.gen_random_bytes(10);
  bits text;
  random_bits text := '';
  result text := '';
  position integer;
  value integer;
BEGIN
  IF timestamp_ms < 0 OR timestamp_ms >= 281474976710656 THEN
    RAISE EXCEPTION 'timestamp is outside the ULID 48-bit range'
      USING ERRCODE = '22003';
  END IF;

  FOR position IN 0..9 LOOP
    random_bits := random_bits || (get_byte(randomness, position)::bit(8))::text;
  END LOOP;

  -- A ULID is 128 bits rendered as 26 Crockford Base32 characters. Prefixing
  -- two zero bits produces the required 130-bit encoding without precision
  -- loss or non-cryptographic randomness.
  bits := '00' || (timestamp_ms::bit(48))::text || random_bits;
  FOR position IN 0..25 LOOP
    value := (substring(bits FROM position * 5 + 1 FOR 5)::bit(5))::integer;
    result := result || substring(alphabet FROM value + 1 FOR 1);
  END LOOP;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.generate_ulid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control_plane.generate_ulid() TO service_role;

CREATE TABLE IF NOT EXISTS control_plane.internal_operators (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),
  enabled boolean NOT NULL DEFAULT true,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  CHECK ((enabled AND revoked_at IS NULL) OR (NOT enabled AND revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS internal_operators_email_unique
  ON control_plane.internal_operators (email);

ALTER TABLE control_plane.internal_operators ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.is_internal_operator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM control_plane.internal_operators AS operator
    WHERE operator.user_id = auth.uid()
      AND operator.enabled
      AND operator.revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION control_plane.require_current_tenant_id()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  requested_tenant text := nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '');
  resolved_tenant text;
  tenant_count integer;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  IF requested_tenant IS NOT NULL THEN
    IF NOT control_plane.is_tenant_member(requested_tenant) THEN
      RAISE EXCEPTION 'active tenant is not available to this user' USING ERRCODE = '42501';
    END IF;
    RETURN requested_tenant;
  END IF;

  SELECT min(membership.tenant_id), count(*)::integer
    INTO resolved_tenant, tenant_count
  FROM control_plane.memberships AS membership
  WHERE membership.user_id = actor
    AND membership.status = 'active';

  IF tenant_count = 0 THEN
    RAISE EXCEPTION 'no Albert organisation exists for this user' USING ERRCODE = 'P0002';
  END IF;
  IF tenant_count > 1 THEN
    RAISE EXCEPTION 'an active tenant must be selected' USING ERRCODE = '22023';
  END IF;
  RETURN resolved_tenant;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.is_internal_operator() FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.require_current_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control_plane.is_internal_operator() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION control_plane.require_current_tenant_id() TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS control_plane.oauth_secret_envelopes (
  tenant_id text NOT NULL,
  oauth_secret_envelope_id text NOT NULL CHECK (control_plane.is_ulid(oauth_secret_envelope_id)),
  token_ref_id text NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  algorithm text NOT NULL DEFAULT 'AES-256-GCM' CHECK (algorithm = 'AES-256-GCM'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  authentication_tag bytea NOT NULL CHECK (octet_length(authentication_tag) = 16),
  wrapped_data_key bytea NOT NULL CHECK (octet_length(wrapped_data_key) > 0),
  key_reference text NOT NULL CHECK (length(btrim(key_reference)) > 0),
  key_version text NOT NULL CHECK (length(btrim(key_version)) > 0),
  aad_digest text NOT NULL CHECK (aad_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (tenant_id, oauth_secret_envelope_id),
  UNIQUE (tenant_id, token_ref_id, credential_version),
  FOREIGN KEY (tenant_id, token_ref_id)
    REFERENCES control_plane.oauth_token_refs(tenant_id, token_ref_id) ON DELETE CASCADE,
  CHECK (retired_at IS NULL OR retired_at >= created_at)
);

COMMENT ON TABLE control_plane.oauth_secret_envelopes IS
  'Worker-only envelope-encrypted OAuth credentials. Plaintext tokens and unwrapped data keys are prohibited. No authenticated or anon grants exist.';

CREATE UNIQUE INDEX IF NOT EXISTS oauth_secret_envelopes_one_active
  ON control_plane.oauth_secret_envelopes (tenant_id, token_ref_id)
  WHERE retired_at IS NULL;

ALTER TABLE control_plane.oauth_secret_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.oauth_secret_envelopes FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS control_plane.oauth_session_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.oauth_session_status_lookup (status, description) VALUES
  ('pending', 'Authorisation was initiated and is awaiting the vendor callback'),
  ('selecting_account', 'The callback returned more than one account choice'),
  ('exchanging', 'The selected account is being exchanged into a connection'),
  ('consumed', 'The single-use session completed successfully'),
  ('expired', 'The session passed its expiry without completion'),
  ('failed', 'The session failed and cannot be reused')
ON CONFLICT (status) DO NOTHING;

CREATE TABLE IF NOT EXISTS control_plane.oauth_sessions (
  tenant_id text NOT NULL,
  oauth_session_id text NOT NULL CHECK (control_plane.is_ulid(oauth_session_id)),
  initiated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('lightspeed-r', 'xero', 'deputy')),
  state_nonce_hash text NOT NULL UNIQUE CHECK (state_nonce_hash ~ '^[0-9a-f]{64}$'),
  pkce_verifier_secret_reference text
    CHECK (pkce_verifier_secret_reference IS NULL OR length(btrim(pkce_verifier_secret_reference)) > 0),
  redirect_uri text NOT NULL CHECK (redirect_uri ~ '^https://'),
  requested_scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'pending'
    REFERENCES control_plane.oauth_session_status_lookup(status),
  discovered_account_choices jsonb,
  selected_account_reference text,
  failure_code text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id, oauth_session_id),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at),
  CHECK (
    discovered_account_choices IS NULL
    OR jsonb_typeof(discovered_account_choices) = 'array'
  ),
  CHECK (
    (status = 'consumed' AND consumed_at IS NOT NULL)
    OR (status <> 'consumed' AND consumed_at IS NULL)
  )
);

COMMENT ON TABLE control_plane.oauth_sessions IS
  'Single-use OAuth transaction metadata. State is stored only as SHA-256; PKCE verifiers are opaque secret-store references. Tokens and plaintext verifiers are prohibited.';

CREATE INDEX IF NOT EXISTS oauth_sessions_initiator_idx
  ON control_plane.oauth_sessions (tenant_id, initiated_by, created_at DESC);
CREATE INDEX IF NOT EXISTS oauth_sessions_expiry_idx
  ON control_plane.oauth_sessions (status, expires_at);

ALTER TABLE control_plane.oauth_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oauth_initiator_read ON control_plane.oauth_sessions;
CREATE POLICY oauth_initiator_read ON control_plane.oauth_sessions
  FOR SELECT TO authenticated
  USING (
    initiated_by = auth.uid()
    AND control_plane.is_tenant_member(tenant_id)
  );

DROP TRIGGER IF EXISTS oauth_sessions_touch_updated_at
  ON control_plane.oauth_sessions;
CREATE TRIGGER oauth_sessions_touch_updated_at
  BEFORE UPDATE ON control_plane.oauth_sessions
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

CREATE TABLE IF NOT EXISTS control_plane.oauth_session_secret_envelopes (
  tenant_id text NOT NULL,
  oauth_session_secret_id text NOT NULL CHECK (control_plane.is_ulid(oauth_session_secret_id)),
  oauth_session_id text NOT NULL,
  secret_reference text NOT NULL UNIQUE CHECK (length(btrim(secret_reference)) > 0),
  secret_kind text NOT NULL CHECK (secret_kind IN ('pkce_verifier', 'exchanged_credential')),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  algorithm text NOT NULL DEFAULT 'AES-256-GCM' CHECK (algorithm = 'AES-256-GCM'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  authentication_tag bytea NOT NULL CHECK (octet_length(authentication_tag) = 16),
  wrapped_data_key bytea NOT NULL CHECK (octet_length(wrapped_data_key) > 0),
  key_reference text NOT NULL CHECK (length(btrim(key_reference)) > 0),
  key_version text NOT NULL CHECK (length(btrim(key_version)) > 0),
  aad_digest text NOT NULL CHECK (aad_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  destroyed_at timestamptz,
  PRIMARY KEY (tenant_id, oauth_session_secret_id),
  UNIQUE (tenant_id, oauth_session_id, secret_kind, credential_version),
  FOREIGN KEY (tenant_id, oauth_session_id)
    REFERENCES control_plane.oauth_sessions(tenant_id, oauth_session_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (destroyed_at IS NULL OR destroyed_at >= created_at)
);

COMMENT ON TABLE control_plane.oauth_session_secret_envelopes IS
  'Worker-only encrypted PKCE verifier and provisional exchanged OAuth credential material. Each secret has a random DEK wrapped by the configured KEK/KMS key.';

CREATE UNIQUE INDEX IF NOT EXISTS oauth_session_secret_one_active_kind
  ON control_plane.oauth_session_secret_envelopes (tenant_id, oauth_session_id, secret_kind)
  WHERE consumed_at IS NULL AND destroyed_at IS NULL;

ALTER TABLE control_plane.oauth_session_secret_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.oauth_session_secret_envelopes FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS oauth_session_secret_tenant_reference_unique
  ON control_plane.oauth_session_secret_envelopes (tenant_id, secret_reference);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'oauth_sessions_pkce_envelope_fk'
      AND conrelid = 'control_plane.oauth_sessions'::regclass
  ) THEN
    ALTER TABLE control_plane.oauth_sessions
      ADD CONSTRAINT oauth_sessions_pkce_envelope_fk
      FOREIGN KEY (tenant_id, pkce_verifier_secret_reference)
      REFERENCES control_plane.oauth_session_secret_envelopes(tenant_id, secret_reference)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;

ALTER TABLE control_plane.oauth_sessions
  DROP CONSTRAINT IF EXISTS oauth_sessions_pkce_required_check;
ALTER TABLE control_plane.oauth_sessions
  ADD CONSTRAINT oauth_sessions_pkce_required_check CHECK (
    status IN ('consumed', 'expired', 'failed')
    OR pkce_verifier_secret_reference IS NOT NULL
  );

CREATE TABLE IF NOT EXISTS control_plane.operator_audit_log (
  operator_audit_id text PRIMARY KEY CHECK (control_plane.is_ulid(operator_audit_id)),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (length(btrim(action)) > 0),
  target_tenant_id text REFERENCES control_plane.tenants(tenant_id) ON DELETE SET NULL,
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(request_metadata) = 'object')
);

ALTER TABLE control_plane.operator_audit_log ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.reject_operator_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'control_plane.operator_audit_log is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS operator_audit_log_reject_mutation
  ON control_plane.operator_audit_log;
CREATE TRIGGER operator_audit_log_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.operator_audit_log
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_operator_audit_mutation();

CREATE TABLE IF NOT EXISTS control_plane.onboarding_question_responses (
  tenant_id text NOT NULL,
  response_id text NOT NULL CHECK (control_plane.is_ulid(response_id)),
  question_id text NOT NULL CHECK (question_id ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  option_id text NOT NULL CHECK (option_id ~ '^[a-z0-9][a-z0-9_.:-]{0,119}$'),
  response_version integer NOT NULL CHECK (response_version > 0),
  previous_response_id text,
  answered_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  answered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, response_id),
  UNIQUE (tenant_id, question_id, response_version),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, previous_response_id)
    REFERENCES control_plane.onboarding_question_responses(tenant_id, response_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS onboarding_responses_current_idx
  ON control_plane.onboarding_question_responses
  (tenant_id, question_id, response_version DESC);

ALTER TABLE control_plane.onboarding_question_responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_members_read
  ON control_plane.onboarding_question_responses;
CREATE POLICY tenant_members_read
  ON control_plane.onboarding_question_responses
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

CREATE TABLE IF NOT EXISTS control_plane.identity_review_decisions (
  tenant_id text NOT NULL,
  decision_id text NOT NULL CHECK (control_plane.is_ulid(decision_id)),
  identity_review_task_id text NOT NULL,
  decision_version integer NOT NULL CHECK (decision_version > 0),
  decision text NOT NULL CHECK (decision IN ('accepted', 'rejected', 'proposed')),
  previous_decision_id text,
  decided_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, decision_id),
  UNIQUE (tenant_id, identity_review_task_id, decision_version),
  FOREIGN KEY (tenant_id, identity_review_task_id)
    REFERENCES control_plane.identity_review_tasks(tenant_id, identity_review_task_id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, previous_decision_id)
    REFERENCES control_plane.identity_review_decisions(tenant_id, decision_id)
    ON DELETE RESTRICT
);

ALTER TABLE control_plane.identity_review_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_members_read
  ON control_plane.identity_review_decisions;
CREATE POLICY tenant_members_read
  ON control_plane.identity_review_decisions
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

CREATE TABLE IF NOT EXISTS control_plane.conversation_turn_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.conversation_turn_status_lookup (status, description) VALUES
  ('running', 'The server is executing the turn'),
  ('completed', 'The turn completed and is resumable'),
  ('failed', 'The turn failed before completion')
ON CONFLICT (status) DO NOTHING;

CREATE TABLE IF NOT EXISTS control_plane.conversation_turns (
  tenant_id text NOT NULL,
  turn_id text NOT NULL CHECK (length(btrim(turn_id)) BETWEEN 8 AND 128),
  conversation_id text NOT NULL,
  turn_number integer NOT NULL CHECK (turn_number > 0),
  user_message text NOT NULL CHECK (length(btrim(user_message)) BETWEEN 1 AND 40000),
  runtime_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'running'
    REFERENCES control_plane.conversation_turn_status_lookup(status),
  provider_response_id text,
  usage jsonb,
  answer_state text REFERENCES control_plane.answer_state_lookup(state),
  result_digest text,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, turn_id),
  UNIQUE (tenant_id, conversation_id, turn_number),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES control_plane.conversations(tenant_id, conversation_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(runtime_profile) = 'object'),
  CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object'),
  CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
  )
);

COMMENT ON COLUMN control_plane.conversation_turns.provider_response_id IS
  'Server continuation state. It is intentionally absent from all workspace/read APIs and table grants.';

CREATE TABLE IF NOT EXISTS control_plane.conversation_turn_events (
  tenant_id text NOT NULL,
  turn_event_id text NOT NULL CHECK (control_plane.is_ulid(turn_event_id)),
  conversation_id text NOT NULL,
  turn_id text NOT NULL,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  event jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, turn_event_id),
  UNIQUE (tenant_id, turn_id, sequence_number),
  FOREIGN KEY (tenant_id, turn_id)
    REFERENCES control_plane.conversation_turns(tenant_id, turn_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES control_plane.conversations(tenant_id, conversation_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(event) = 'object')
);

CREATE TABLE IF NOT EXISTS control_plane.model_usage_ledger (
  tenant_id text NOT NULL,
  usage_ledger_id text NOT NULL CHECK (control_plane.is_ulid(usage_ledger_id)),
  conversation_id text NOT NULL,
  turn_id text NOT NULL,
  rate_card_id text NOT NULL CHECK (rate_card_id ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
  model text NOT NULL CHECK (model IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')),
  fast_mode boolean NOT NULL,
  requests integer NOT NULL CHECK (requests >= 0),
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  cached_input_tokens bigint NOT NULL CHECK (cached_input_tokens >= 0),
  cache_write_input_tokens bigint NOT NULL CHECK (cache_write_input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  estimated_cost_usd_micros bigint NOT NULL CHECK (estimated_cost_usd_micros >= 0),
  pricing_completeness text NOT NULL
    CHECK (pricing_completeness IN ('request_level', 'aggregate_estimate')),
  metering_digest text NOT NULL CHECK (metering_digest ~ '^[0-9a-f]{64}$'),
  recorded_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, usage_ledger_id),
  UNIQUE (tenant_id, turn_id),
  FOREIGN KEY (tenant_id, turn_id)
    REFERENCES control_plane.conversation_turns(tenant_id, turn_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES control_plane.conversations(tenant_id, conversation_id) ON DELETE RESTRICT,
  CHECK (cached_input_tokens + cache_write_input_tokens <= input_tokens)
);

COMMENT ON TABLE control_plane.model_usage_ledger IS
  'Append-only per-turn model usage and estimated cost attribution. Provider organisation billing remains the reconciliation authority.';

CREATE TABLE IF NOT EXISTS control_plane.rate_limit_policies (
  action text PRIMARY KEY CHECK (action ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  request_limit integer NOT NULL CHECK (request_limit > 0),
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 1 AND 86400),
  audit_excess boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true
);

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('conversation.turn', 20, 60, true),
  ('oauth.start', 5, 600, true),
  ('oauth.callback', 10, 600, true),
  ('oauth.select', 10, 600, true),
  ('oauth.disconnect', 5, 3600, true),
  ('review.mutation', 30, 60, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess;

CREATE TABLE IF NOT EXISTS control_plane.rate_limit_buckets (
  tenant_id text NOT NULL,
  actor_key text NOT NULL CHECK (length(btrim(actor_key)) BETWEEN 8 AND 160),
  action text NOT NULL REFERENCES control_plane.rate_limit_policies(action),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_key, action, window_started_at),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_expiry_idx
  ON control_plane.rate_limit_buckets (window_started_at);

ALTER TABLE control_plane.model_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.reject_usage_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'control_plane.model_usage_ledger is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS model_usage_ledger_reject_mutation
  ON control_plane.model_usage_ledger;
CREATE TRIGGER model_usage_ledger_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.model_usage_ledger
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_usage_mutation();

CREATE INDEX IF NOT EXISTS conversation_turns_order_idx
  ON control_plane.conversation_turns (tenant_id, conversation_id, turn_number);
CREATE INDEX IF NOT EXISTS conversation_turn_events_order_idx
  ON control_plane.conversation_turn_events (tenant_id, turn_id, sequence_number);

ALTER TABLE control_plane.conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.conversation_turn_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.reject_turn_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'control_plane.conversation_turn_events is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.trace_event_has_forbidden_key(document jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  entry record;
  child jsonb;
  normalized text;
BEGIN
  IF jsonb_typeof(document) = 'object' THEN
    FOR entry IN SELECT key, value FROM jsonb_each(document) LOOP
      normalized := regexp_replace(lower(entry.key), '[^a-z0-9]', '', 'g');
      IF normalized IN (
        'chainofthought', 'compiledsql', 'prompt', 'rawpayload',
        'rawproviderpayload', 'rawprovideroutput', 'rawreasoning',
        'rawtoolarguments', 'rawtooloutput', 'reasoning', 'sql',
        'toolarguments', 'tooloutput'
      ) THEN
        RETURN true;
      END IF;
      IF jsonb_typeof(entry.value) IN ('object', 'array')
         AND control_plane.trace_event_has_forbidden_key(entry.value) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(document) = 'array' THEN
    FOR child IN SELECT value FROM jsonb_array_elements(document) LOOP
      IF jsonb_typeof(child) IN ('object', 'array')
         AND control_plane.trace_event_has_forbidden_key(child) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.trace_event_has_forbidden_key(jsonb) FROM PUBLIC;

DROP TRIGGER IF EXISTS conversation_turn_events_reject_mutation
  ON control_plane.conversation_turn_events;
CREATE TRIGGER conversation_turn_events_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.conversation_turn_events
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_turn_event_mutation();

CREATE OR REPLACE FUNCTION public.bootstrap_albert_tenant(
  p_display_name text,
  p_timezone text
)
RETURNS TABLE (
  tenant_id text,
  tenant_name text,
  tenant_slug text,
  role text,
  timezone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  existing_tenant text;
  created_tenant text;
  created_membership text;
  created_overlay text;
  normalized_name text := btrim(p_display_name);
  normalized_timezone text := btrim(p_timezone);
  generated_slug text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF length(normalized_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'display name must contain 1 to 120 characters' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = normalized_timezone
  ) THEN
    RAISE EXCEPTION 'timezone is not recognised' USING ERRCODE = '22023';
  END IF;

  SELECT membership.tenant_id
    INTO existing_tenant
  FROM control_plane.memberships AS membership
  WHERE membership.user_id = actor
    AND membership.status = 'active'
  ORDER BY membership.created_at
  LIMIT 1;

  IF existing_tenant IS NOT NULL THEN
    RETURN QUERY
      SELECT tenant.tenant_id,
             tenant.display_name,
             tenant.slug,
             membership.role,
             coalesce(overlay.overlay ->> 'timezone', 'Australia/Melbourne')
      FROM control_plane.tenants AS tenant
      JOIN control_plane.memberships AS membership
        ON membership.tenant_id = tenant.tenant_id
       AND membership.user_id = actor
       AND membership.status = 'active'
      LEFT JOIN LATERAL (
        SELECT candidate.overlay
        FROM control_plane.tenant_overlays AS candidate
        WHERE candidate.tenant_id = tenant.tenant_id
          AND candidate.status = 'published'
        LIMIT 1
      ) AS overlay ON true
      WHERE tenant.tenant_id = existing_tenant;
    RETURN;
  END IF;

  created_tenant := control_plane.generate_ulid();
  created_membership := control_plane.generate_ulid();
  created_overlay := control_plane.generate_ulid();
  generated_slug := left(
    trim(both '-' FROM regexp_replace(lower(normalized_name), '[^a-z0-9]+', '-', 'g')),
    42
  );
  IF generated_slug = '' THEN
    generated_slug := 'organisation';
  END IF;
  generated_slug := generated_slug || '-' || lower(right(created_tenant, 6));

  INSERT INTO control_plane.tenants (
    tenant_id, slug, display_name, status, created_by
  ) VALUES (
    created_tenant, generated_slug, normalized_name, 'active', actor
  );

  INSERT INTO control_plane.memberships (
    tenant_id, membership_id, user_id, role, status, created_by
  ) VALUES (
    created_tenant, created_membership, actor, 'owner', 'active', actor
  );

  INSERT INTO control_plane.placement_registry (
    tenant_id, logical_cell_key, status, placement_metadata
  ) VALUES (
    created_tenant, 'cell_01', 'assigned', '{"region":"ap-southeast-2"}'::jsonb
  );

  INSERT INTO control_plane.tenant_overlays (
    tenant_id, overlay_id, version, status, overlay, change_reason,
    created_by, published_at
  ) VALUES (
    created_tenant,
    created_overlay,
    1,
    'published',
    jsonb_build_object(
      'timezone', normalized_timezone,
      'trading_day_cutoff', '00:00',
      'blocking_answers', '{}'::jsonb
    ),
    'Tenant bootstrap',
    actor,
    now()
  );

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    created_tenant,
    control_plane.generate_ulid(),
    actor,
    'user',
    'tenant.bootstrap',
    'tenant',
    created_tenant,
    jsonb_build_object('timezone', normalized_timezone)
  );

  RETURN QUERY SELECT created_tenant, normalized_name, generated_slug, 'owner'::text,
    normalized_timezone;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_albert_context()
RETURNS TABLE (
  tenant_id text,
  tenant_name text,
  tenant_slug text,
  role text,
  timezone text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT tenant.tenant_id,
         tenant.display_name,
         tenant.slug,
         membership.role,
         coalesce(overlay.overlay ->> 'timezone', 'Australia/Melbourne')
  FROM control_plane.memberships AS membership
  JOIN control_plane.tenants AS tenant
    ON tenant.tenant_id = membership.tenant_id
  LEFT JOIN LATERAL (
    SELECT candidate.overlay
    FROM control_plane.tenant_overlays AS candidate
    WHERE candidate.tenant_id = tenant.tenant_id
      AND candidate.status = 'published'
    LIMIT 1
  ) AS overlay ON true
  WHERE auth.uid() IS NOT NULL
    AND membership.user_id = auth.uid()
    AND membership.status = 'active'
    AND tenant.status = 'active'
    AND (
      nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '') IS NULL
      OR tenant.tenant_id = auth.jwt() -> 'app_metadata' ->> 'active_tenant_id'
    )
  ORDER BY membership.created_at
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.albert_list_conversations(p_limit integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := auth.uid();
  result jsonb;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'conversation limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'conversation_id', conversation.conversation_id,
    'title', conversation.title,
    'status', conversation.status,
    'created_at', conversation.created_at,
    'updated_at', conversation.updated_at,
    'last_turn', (
      SELECT jsonb_build_object(
        'turn_id', turn.turn_id,
        'turn_number', turn.turn_number,
        'user_message', turn.user_message,
        'status', turn.status,
        'answer_state', turn.answer_state,
        'runtime_profile', jsonb_build_object(
          'model', turn.runtime_profile -> 'model',
          'reasoningEffort', turn.runtime_profile -> 'reasoningEffort',
          'fastMode', turn.runtime_profile -> 'fastMode'
        ),
        'created_at', turn.created_at,
        'completed_at', turn.completed_at
      )
      FROM control_plane.conversation_turns AS turn
      WHERE turn.tenant_id = selected_tenant
        AND turn.conversation_id = conversation.conversation_id
        AND turn.created_by = actor
      ORDER BY turn.turn_number DESC
      LIMIT 1
    )
  ) ORDER BY conversation.updated_at DESC), '[]'::jsonb)
  INTO result
  FROM (
    SELECT *
    FROM control_plane.conversations AS candidate
    WHERE candidate.tenant_id = selected_tenant
      AND candidate.created_by = actor
    ORDER BY candidate.updated_at DESC
    LIMIT p_limit
  ) AS conversation;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_conversation_history(
  p_conversation_id text,
  p_after_sequence integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := auth.uid();
  result jsonb;
BEGIN
  IF p_after_sequence < 0 THEN
    RAISE EXCEPTION 'after sequence cannot be negative' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.conversations AS conversation
    WHERE conversation.tenant_id = selected_tenant
      AND conversation.conversation_id = p_conversation_id
      AND conversation.created_by = actor
  ) THEN
    RAISE EXCEPTION 'conversation was not found' USING ERRCODE = 'P0002';
  END IF;

  WITH ordered_events AS (
    SELECT turn.turn_id,
           turn.turn_number,
           event.event,
           row_number() OVER (
             ORDER BY turn.turn_number, event.sequence_number
           )::integer AS conversation_sequence
    FROM control_plane.conversation_turns AS turn
    JOIN control_plane.conversation_turn_events AS event
      ON event.tenant_id = turn.tenant_id
     AND event.turn_id = turn.turn_id
    WHERE turn.tenant_id = selected_tenant
      AND turn.conversation_id = p_conversation_id
      AND turn.created_by = actor
  )
  SELECT jsonb_build_object(
    'conversation_id', p_conversation_id,
    'turns', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'turn_id', turn.turn_id,
        'turn_number', turn.turn_number,
        'user_message', turn.user_message,
        'status', turn.status,
        'answer_state', turn.answer_state,
        'runtime_profile', jsonb_build_object(
          'model', turn.runtime_profile -> 'model',
          'reasoningEffort', turn.runtime_profile -> 'reasoningEffort',
          'fastMode', turn.runtime_profile -> 'fastMode'
        ),
        'created_at', turn.created_at,
        'completed_at', turn.completed_at,
        'events', coalesce((
          SELECT jsonb_agg(
            event.event || jsonb_build_object(
              'conversationSequence', event.conversation_sequence
            ) ORDER BY event.conversation_sequence
          )
          FROM ordered_events AS event
          WHERE event.turn_id = turn.turn_id
            AND event.conversation_sequence > p_after_sequence
        ), '[]'::jsonb)
      ) ORDER BY turn.turn_number)
      FROM control_plane.conversation_turns AS turn
      WHERE turn.tenant_id = selected_tenant
        AND turn.conversation_id = p_conversation_id
        AND turn.created_by = actor
        AND (
          p_after_sequence = 0
          OR turn.status IN ('running', 'failed')
          OR EXISTS (
            SELECT 1 FROM ordered_events AS event
            WHERE event.turn_id = turn.turn_id
              AND event.conversation_sequence > p_after_sequence
          )
        )
    ), '[]'::jsonb),
    'next_sequence', coalesce((SELECT max(conversation_sequence) FROM ordered_events), 0)
  ) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_connections_workspace()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'tenant_id', tenant.tenant_id,
    'tenant_name', tenant.display_name,
    'connections', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'connection_id', connection.connection_id,
        'connector_key', connection.connector_key,
        'display_name', connection.display_name,
        'status', connection.status,
        'auth_health', connection.auth_health,
        'authorised_at', connection.authorised_at,
        'last_checked_at', connection.last_checked_at,
        'readiness', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'domain', readiness.domain,
            'state', readiness.state,
            'progress', readiness.progress,
            'data_ready_through', readiness.data_ready_through,
            'backfill_complete', readiness.backfill_complete,
            'reason_code', readiness.reason_code
          ) ORDER BY readiness.domain)
          FROM control_plane.readiness AS readiness
          WHERE readiness.tenant_id = selected_tenant
            AND readiness.connection_id = connection.connection_id
        ), '[]'::jsonb)
      ) ORDER BY connection.created_at)
      FROM control_plane.connections AS connection
      WHERE connection.tenant_id = selected_tenant
    ), '[]'::jsonb),
    'dossier', (
      SELECT jsonb_build_object(
        'version', dossier.version,
        'content', dossier.content,
        'provenance', dossier.provenance,
        'published_at', dossier.published_at
      )
      FROM control_plane.dossiers AS dossier
      WHERE dossier.tenant_id = selected_tenant
        AND dossier.status = 'published'
      LIMIT 1
    ),
    'identity_review_tasks', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'task_id', task.identity_review_task_id,
        'entity_type', task.entity_type,
        'status', task.status,
        'confidence_band', task.confidence_band,
        'candidate_links', task.candidate_links,
        'evidence', task.evidence,
        'resolution', task.resolution
      ) ORDER BY task.created_at)
      FROM control_plane.identity_review_tasks AS task
      WHERE task.tenant_id = selected_tenant
    ), '[]'::jsonb),
    'blocking_answers', coalesce((
      SELECT overlay.overlay -> 'blocking_answers'
      FROM control_plane.tenant_overlays AS overlay
      WHERE overlay.tenant_id = selected_tenant
        AND overlay.status = 'published'
      LIMIT 1
    ), '{}'::jsonb),
    'oauth_sessions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'oauth_session_id', session.oauth_session_id,
        'provider', session.provider,
        'status', session.status,
        'discovered_account_choices', session.discovered_account_choices,
        'expires_at', session.expires_at
      ) ORDER BY session.created_at DESC)
      FROM control_plane.oauth_sessions AS session
      WHERE session.tenant_id = selected_tenant
        AND session.initiated_by = auth.uid()
        AND session.status IN ('pending', 'selecting_account', 'exchanging')
        AND session.expires_at > now()
    ), '[]'::jsonb)
  ) INTO result
  FROM control_plane.tenants AS tenant
  WHERE tenant.tenant_id = selected_tenant;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_answer_blocking_question(
  p_question_id text,
  p_option_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  current_overlay control_plane.tenant_overlays%ROWTYPE;
  previous_response text;
  next_response_version integer;
  next_overlay jsonb;
BEGIN
  IF NOT control_plane.has_tenant_role(selected_tenant, ARRAY['owner', 'manager']::text[]) THEN
    RAISE EXCEPTION 'owner or manager role required' USING ERRCODE = '42501';
  END IF;
  IF p_question_id !~ '^[a-z][a-z0-9_.-]{1,79}$'
     OR p_option_id !~ '^[a-z0-9][a-z0-9_.:-]{0,119}$' THEN
    RAISE EXCEPTION 'question or option identifier is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO current_overlay
  FROM control_plane.tenant_overlays AS overlay
  WHERE overlay.tenant_id = selected_tenant
    AND overlay.status = 'published'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'published tenant overlay is missing' USING ERRCODE = 'P0002';
  END IF;

  SELECT response.response_id, response.response_version + 1
    INTO previous_response, next_response_version
  FROM control_plane.onboarding_question_responses AS response
  WHERE response.tenant_id = selected_tenant
    AND response.question_id = p_question_id
  ORDER BY response.response_version DESC
  LIMIT 1;
  next_response_version := coalesce(next_response_version, 1);

  INSERT INTO control_plane.onboarding_question_responses (
    tenant_id, response_id, question_id, option_id, response_version,
    previous_response_id, answered_by
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), p_question_id, p_option_id,
    next_response_version, previous_response, actor
  );

  next_overlay := jsonb_set(
    current_overlay.overlay || jsonb_build_object(
      'blocking_answers', coalesce(current_overlay.overlay -> 'blocking_answers', '{}'::jsonb)
    ),
    ARRAY['blocking_answers', p_question_id],
    to_jsonb(p_option_id),
    true
  );

  UPDATE control_plane.tenant_overlays
  SET status = 'superseded', superseded_at = now()
  WHERE tenant_id = selected_tenant
    AND overlay_id = current_overlay.overlay_id;

  INSERT INTO control_plane.tenant_overlays (
    tenant_id, overlay_id, version, status, overlay, change_reason,
    created_by, published_at
  ) VALUES (
    selected_tenant,
    control_plane.generate_ulid(),
    current_overlay.version + 1,
    'published',
    next_overlay,
    'Blocking question answered: ' || p_question_id,
    actor,
    now()
  );

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'onboarding.blocking_question_answered', 'onboarding_question', p_question_id,
    jsonb_build_object('option_id', p_option_id, 'overlay_version', current_overlay.version + 1)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_decide_identity_match(
  p_task_id text,
  p_decision text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  task control_plane.identity_review_tasks%ROWTYPE;
  prior_decision text;
  next_version integer;
BEGIN
  IF NOT control_plane.has_tenant_role(selected_tenant, ARRAY['owner', 'manager']::text[]) THEN
    RAISE EXCEPTION 'owner or manager role required' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('accepted', 'rejected', 'proposed') THEN
    RAISE EXCEPTION 'decision must be accepted, rejected, or proposed' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO task
  FROM control_plane.identity_review_tasks AS candidate
  WHERE candidate.tenant_id = selected_tenant
    AND candidate.identity_review_task_id = p_task_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'identity review task was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT decision.decision_id, decision.decision_version + 1
    INTO prior_decision, next_version
  FROM control_plane.identity_review_decisions AS decision
  WHERE decision.tenant_id = selected_tenant
    AND decision.identity_review_task_id = p_task_id
  ORDER BY decision.decision_version DESC
  LIMIT 1;
  next_version := coalesce(next_version, 1);

  INSERT INTO control_plane.identity_review_decisions (
    tenant_id, decision_id, identity_review_task_id, decision_version,
    decision, previous_decision_id, decided_by
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), p_task_id, next_version,
    p_decision, prior_decision, actor
  );

  UPDATE control_plane.identity_review_tasks
  SET status = p_decision,
      resolved_by = CASE WHEN p_decision = 'proposed' THEN NULL ELSE actor END,
      resolution = jsonb_build_object('decision', p_decision, 'version', next_version),
      resolved_at = CASE WHEN p_decision = 'proposed' THEN NULL ELSE now() END,
      updated_at = now()
  WHERE tenant_id = selected_tenant
    AND identity_review_task_id = p_task_id;

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'identity.match_decided', 'identity_review_task', p_task_id,
    jsonb_build_object('decision', p_decision, 'decision_version', next_version)
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.create_oauth_session(
  p_tenant_id text,
  p_initiated_by uuid,
  p_provider text,
  p_state_nonce_hash text,
  p_pkce_verifier_secret_reference text,
  p_redirect_uri text,
  p_requested_scopes text[],
  p_expires_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  generated_session text := control_plane.generate_ulid();
BEGIN
  IF p_provider NOT IN ('lightspeed-r', 'xero', 'deputy')
     OR p_state_nonce_hash !~ '^[0-9a-f]{64}$'
     OR p_redirect_uri !~ '^https://'
     OR p_expires_at <= now()
     OR p_expires_at > now() + interval '30 minutes'
     OR p_pkce_verifier_secret_reference IS NULL
     OR length(btrim(p_pkce_verifier_secret_reference)) = 0 THEN
    RAISE EXCEPTION 'OAuth session input is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.memberships AS membership
    WHERE membership.tenant_id = p_tenant_id
      AND membership.user_id = p_initiated_by
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'manager')
  ) THEN
    RAISE EXCEPTION 'OAuth initiator is not a connection administrator' USING ERRCODE = '42501';
  END IF;

  INSERT INTO control_plane.oauth_sessions (
    tenant_id, oauth_session_id, initiated_by, provider, state_nonce_hash,
    pkce_verifier_secret_reference, redirect_uri, requested_scopes,
    status, expires_at
  ) VALUES (
    p_tenant_id, generated_session, p_initiated_by, p_provider,
    p_state_nonce_hash, p_pkce_verifier_secret_reference, p_redirect_uri,
    coalesce(p_requested_scopes, ARRAY[]::text[]), 'pending', p_expires_at
  );

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    p_tenant_id, control_plane.generate_ulid(), p_initiated_by, 'service',
    'oauth.session_created', 'oauth_session', generated_session,
    jsonb_build_object('provider', p_provider, 'expires_at', p_expires_at)
  );
  RETURN generated_session;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.transition_oauth_session(
  p_oauth_session_id text,
  p_state_nonce_hash text,
  p_expected_status text,
  p_next_status text,
  p_discovered_account_choices jsonb DEFAULT NULL,
  p_selected_account_reference text DEFAULT NULL,
  p_failure_code text DEFAULT NULL
)
RETURNS TABLE (
  tenant_id text,
  initiated_by uuid,
  provider text,
  pkce_verifier_secret_reference text,
  redirect_uri text,
  requested_scopes text[],
  status text,
  discovered_account_choices jsonb,
  selected_account_reference text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  session control_plane.oauth_sessions%ROWTYPE;
BEGIN
  IF p_state_nonce_hash !~ '^[0-9a-f]{64}$'
     OR p_expected_status NOT IN ('pending', 'selecting_account', 'exchanging')
     OR p_next_status NOT IN ('selecting_account', 'exchanging', 'consumed', 'failed')
     OR (p_discovered_account_choices IS NOT NULL
       AND jsonb_typeof(p_discovered_account_choices) <> 'array')
     OR (p_failure_code IS NOT NULL AND p_failure_code !~ '^[a-z][a-z0-9_.-]{1,79}$') THEN
    RAISE EXCEPTION 'OAuth transition input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO session
  FROM control_plane.oauth_sessions AS candidate
  WHERE candidate.oauth_session_id = p_oauth_session_id
    AND candidate.state_nonce_hash = p_state_nonce_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAuth session was not found' USING ERRCODE = 'P0002';
  END IF;
  IF session.expires_at <= now() THEN
    UPDATE control_plane.oauth_sessions
    SET status = 'expired', failure_code = 'session_expired'
    WHERE oauth_sessions.tenant_id = session.tenant_id
      AND oauth_sessions.oauth_session_id = session.oauth_session_id;
    RAISE EXCEPTION 'OAuth session expired' USING ERRCODE = '22023';
  END IF;
  IF session.status <> p_expected_status OR session.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'OAuth session is not in the expected single-use state' USING ERRCODE = '55000';
  END IF;
  IF p_next_status = 'selecting_account'
     AND (p_discovered_account_choices IS NULL OR jsonb_array_length(p_discovered_account_choices) < 2) THEN
    RAISE EXCEPTION 'account selection requires multiple choices' USING ERRCODE = '22023';
  END IF;
  IF p_next_status = 'exchanging' AND p_selected_account_reference IS NULL THEN
    RAISE EXCEPTION 'account exchange requires a selected account' USING ERRCODE = '22023';
  END IF;
  IF p_next_status = 'consumed' AND session.selected_account_reference IS NULL
     AND p_selected_account_reference IS NULL THEN
    RAISE EXCEPTION 'consuming OAuth requires a selected account' USING ERRCODE = '22023';
  END IF;

  UPDATE control_plane.oauth_sessions
  SET status = p_next_status,
      discovered_account_choices = coalesce(
        p_discovered_account_choices,
        oauth_sessions.discovered_account_choices
      ),
      selected_account_reference = coalesce(
        p_selected_account_reference,
        oauth_sessions.selected_account_reference
      ),
      failure_code = p_failure_code,
      consumed_at = CASE WHEN p_next_status = 'consumed' THEN now() ELSE NULL END
  WHERE oauth_sessions.tenant_id = session.tenant_id
    AND oauth_sessions.oauth_session_id = session.oauth_session_id;

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    session.tenant_id, control_plane.generate_ulid(), session.initiated_by,
    'service', 'oauth.session_transitioned', 'oauth_session', session.oauth_session_id,
    jsonb_build_object('from', p_expected_status, 'to', p_next_status, 'provider', session.provider)
  );

  RETURN QUERY
    SELECT updated.tenant_id, updated.initiated_by, updated.provider,
           updated.pkce_verifier_secret_reference, updated.redirect_uri,
           updated.requested_scopes, updated.status,
           updated.discovered_account_choices, updated.selected_account_reference
    FROM control_plane.oauth_sessions AS updated
    WHERE updated.tenant_id = session.tenant_id
      AND updated.oauth_session_id = session.oauth_session_id;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.create_oauth_session(text, uuid, text, text, text, text, text[], timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.transition_oauth_session(text, text, text, text, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control_plane.create_oauth_session(text, uuid, text, text, text, text, text[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.transition_oauth_session(text, text, text, text, jsonb, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.begin_albert_turn(
  p_conversation_id text,
  p_turn_id text,
  p_user_message text,
  p_runtime_profile jsonb
)
RETURNS TABLE (conversation_id text, previous_response_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  resolved_conversation text := p_conversation_id;
  next_turn integer;
  previous_provider_response text;
BEGIN
  IF length(btrim(p_turn_id)) NOT BETWEEN 8 AND 128
     OR length(btrim(p_user_message)) NOT BETWEEN 1 AND 40000
     OR p_runtime_profile IS NULL
     OR jsonb_typeof(p_runtime_profile) <> 'object' THEN
    RAISE EXCEPTION 'turn input is invalid' USING ERRCODE = '22023';
  END IF;

  IF resolved_conversation IS NULL THEN
    resolved_conversation := control_plane.generate_ulid();
    INSERT INTO control_plane.conversations (
      tenant_id, conversation_id, status, created_by
    ) VALUES (
      selected_tenant, resolved_conversation, 'active', actor
    );
  ELSE
    PERFORM 1
    FROM control_plane.conversations AS conversation
    WHERE conversation.tenant_id = selected_tenant
      AND conversation.conversation_id = resolved_conversation
      AND conversation.created_by = actor
      AND conversation.status = 'active'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation was not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  SELECT turn.conversation_id
    INTO conversation_id
  FROM control_plane.conversation_turns AS turn
  WHERE turn.tenant_id = selected_tenant
    AND turn.turn_id = p_turn_id;
  IF FOUND THEN
    IF conversation_id <> resolved_conversation THEN
      RAISE EXCEPTION 'turn id belongs to another conversation' USING ERRCODE = '23505';
    END IF;
    SELECT completed.provider_response_id
      INTO previous_provider_response
    FROM control_plane.conversation_turns AS completed
    WHERE completed.tenant_id = selected_tenant
      AND completed.conversation_id = resolved_conversation
      AND completed.status = 'completed'
      AND completed.turn_number < (
        SELECT existing.turn_number
        FROM control_plane.conversation_turns AS existing
        WHERE existing.tenant_id = selected_tenant AND existing.turn_id = p_turn_id
      )
    ORDER BY completed.turn_number DESC
    LIMIT 1;
    previous_response_id := previous_provider_response;
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(selected_tenant || ':' || resolved_conversation, 0));
  SELECT coalesce(max(turn.turn_number), 0) + 1
    INTO next_turn
  FROM control_plane.conversation_turns AS turn
  WHERE turn.tenant_id = selected_tenant
    AND turn.conversation_id = resolved_conversation;

  SELECT turn.provider_response_id
    INTO previous_provider_response
  FROM control_plane.conversation_turns AS turn
  WHERE turn.tenant_id = selected_tenant
    AND turn.conversation_id = resolved_conversation
    AND turn.status = 'completed'
  ORDER BY turn.turn_number DESC
  LIMIT 1;

  INSERT INTO control_plane.conversation_turns (
    tenant_id, turn_id, conversation_id, turn_number, user_message,
    runtime_profile, status, created_by
  ) VALUES (
    selected_tenant, p_turn_id, resolved_conversation, next_turn, btrim(p_user_message),
    p_runtime_profile, 'running', actor
  );

  UPDATE control_plane.conversations
  SET updated_at = now()
  WHERE tenant_id = selected_tenant
    AND conversation_id = resolved_conversation;

  conversation_id := resolved_conversation;
  previous_response_id := previous_provider_response;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_answer_event_append(
  p_conversation_id text,
  p_turn_id text,
  p_event jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  next_sequence integer;
BEGIN
  IF p_event IS NULL OR jsonb_typeof(p_event) <> 'object'
     OR octet_length(p_event::text) > 2097152
     OR coalesce(p_event ->> 'id', '') !~ '^.{1,128}$'
     OR coalesce(p_event ->> 'type', '') NOT IN (
       'progress', 'narrative', 'query', 'table', 'chart',
       'validation', 'answer', 'clarification', 'error'
     )
     OR coalesce(p_event ->> 'sequence', '') !~ '^[1-9][0-9]*$'
     OR coalesce(p_event ->> 'occurredAt', '') IN ('', 'infinity', '-infinity')
     OR control_plane.trace_event_has_forbidden_key(p_event) THEN
    RAISE EXCEPTION 'event must be an object' USING ERRCODE = '22023';
  END IF;
  BEGIN
    PERFORM (p_event ->> 'occurredAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'event occurredAt is invalid' USING ERRCODE = '22023';
  END;

  PERFORM 1
  FROM control_plane.conversation_turns AS turn
  JOIN control_plane.conversations AS conversation
    ON conversation.tenant_id = turn.tenant_id
   AND conversation.conversation_id = turn.conversation_id
  WHERE turn.tenant_id = selected_tenant
    AND turn.turn_id = p_turn_id
    AND turn.conversation_id = p_conversation_id
    AND turn.status = 'running'
    AND turn.created_by = actor
    AND conversation.created_by = actor
  FOR UPDATE OF turn;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'running conversation turn was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(max(event.sequence_number), 0) + 1
    INTO next_sequence
  FROM control_plane.conversation_turn_events AS event
  WHERE event.tenant_id = selected_tenant
    AND event.turn_id = p_turn_id;

  IF (p_event ->> 'sequence')::integer <> next_sequence THEN
    RAISE EXCEPTION 'event sequence is not contiguous' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.conversation_turn_events (
    tenant_id, turn_event_id, conversation_id, turn_id, sequence_number, event
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), p_conversation_id,
    p_turn_id, next_sequence, p_event
  );

  RETURN next_sequence;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_albert_turn(
  p_conversation_id text,
  p_turn_id text,
  p_failure_code text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  current_status text;
BEGIN
  IF p_failure_code !~ '^[a-z][a-z0-9_.-]{1,79}$' THEN
    RAISE EXCEPTION 'failure code is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT turn.status INTO current_status
  FROM control_plane.conversation_turns AS turn
  JOIN control_plane.conversations AS conversation
    ON conversation.tenant_id = turn.tenant_id
   AND conversation.conversation_id = turn.conversation_id
  WHERE turn.tenant_id = selected_tenant
    AND turn.turn_id = p_turn_id
    AND turn.conversation_id = p_conversation_id
    AND turn.created_by = actor
    AND conversation.created_by = actor
  FOR UPDATE OF turn;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation turn was not found' USING ERRCODE = 'P0002';
  END IF;
  IF current_status = 'failed' THEN
    RETURN;
  END IF;
  IF current_status <> 'running' THEN
    RAISE EXCEPTION 'only a running turn can fail' USING ERRCODE = '55000';
  END IF;

  UPDATE control_plane.conversation_turns
  SET status = 'failed',
      result_digest = p_failure_code,
      completed_at = now()
  WHERE tenant_id = selected_tenant AND turn_id = p_turn_id;

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'conversation.turn_failed', 'conversation_turn', p_turn_id,
    jsonb_build_object('failure_code', p_failure_code)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_albert_model_usage(
  p_conversation_id text,
  p_turn_id text,
  p_metering jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  turn control_plane.conversation_turns%ROWTYPE;
  digest text;
  existing_digest text;
BEGIN
  IF p_metering IS NULL OR jsonb_typeof(p_metering) <> 'object' THEN
    RAISE EXCEPTION 'metering must be an object' USING ERRCODE = '22023';
  END IF;
  SELECT candidate.* INTO turn
  FROM control_plane.conversation_turns AS candidate
  JOIN control_plane.conversations AS conversation
    ON conversation.tenant_id = candidate.tenant_id
   AND conversation.conversation_id = candidate.conversation_id
  WHERE candidate.tenant_id = selected_tenant
    AND candidate.turn_id = p_turn_id
    AND candidate.conversation_id = p_conversation_id
    AND candidate.created_by = actor
    AND conversation.created_by = actor
  FOR UPDATE OF candidate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation turn was not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_metering ->> 'model' IS DISTINCT FROM turn.runtime_profile ->> 'model'
     OR (p_metering ->> 'fastMode')::boolean IS DISTINCT FROM
        coalesce((turn.runtime_profile ->> 'fastMode')::boolean, false) THEN
    RAISE EXCEPTION 'metering runtime profile does not match the turn' USING ERRCODE = '22023';
  END IF;
  IF p_metering ->> 'model' NOT IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
     OR p_metering ->> 'pricingCompleteness' NOT IN ('request_level', 'aggregate_estimate')
     OR coalesce(p_metering ->> 'rateCardId', '') !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
     OR coalesce(p_metering ->> 'requests', '') !~ '^[0-9]+$'
     OR coalesce(p_metering ->> 'inputTokens', '') !~ '^[0-9]+$'
     OR coalesce(p_metering ->> 'cachedInputTokens', '') !~ '^[0-9]+$'
     OR coalesce(p_metering ->> 'cacheWriteInputTokens', '') !~ '^[0-9]+$'
     OR coalesce(p_metering ->> 'outputTokens', '') !~ '^[0-9]+$'
     OR coalesce(p_metering ->> 'estimatedCostUsdMicros', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'metering fields are invalid' USING ERRCODE = '22023';
  END IF;
  digest := encode(extensions.digest(convert_to(p_metering::text, 'UTF8'), 'sha256'), 'hex');
  SELECT ledger.metering_digest INTO existing_digest
  FROM control_plane.model_usage_ledger AS ledger
  WHERE ledger.tenant_id = selected_tenant AND ledger.turn_id = p_turn_id;
  IF existing_digest IS NOT NULL THEN
    IF existing_digest <> digest THEN
      RAISE EXCEPTION 'turn usage was already recorded differently' USING ERRCODE = '23505';
    END IF;
    RETURN digest;
  END IF;

  INSERT INTO control_plane.model_usage_ledger (
    tenant_id, usage_ledger_id, conversation_id, turn_id, rate_card_id,
    model, fast_mode, requests, input_tokens, cached_input_tokens,
    cache_write_input_tokens, output_tokens, estimated_cost_usd_micros,
    pricing_completeness, metering_digest, recorded_by
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), p_conversation_id, p_turn_id,
    p_metering ->> 'rateCardId', p_metering ->> 'model',
    (p_metering ->> 'fastMode')::boolean,
    (p_metering ->> 'requests')::integer,
    (p_metering ->> 'inputTokens')::bigint,
    (p_metering ->> 'cachedInputTokens')::bigint,
    (p_metering ->> 'cacheWriteInputTokens')::bigint,
    (p_metering ->> 'outputTokens')::bigint,
    (p_metering ->> 'estimatedCostUsdMicros')::bigint,
    p_metering ->> 'pricingCompleteness', digest, actor
  );
  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'model.usage_recorded', 'conversation_turn', p_turn_id,
    jsonb_build_object('metering_digest', digest, 'rate_card_id', p_metering ->> 'rateCardId')
  );
  RETURN digest;
END;
$$;

CREATE OR REPLACE FUNCTION public.consume_albert_rate_limit(
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS TABLE (allowed boolean, retry_after_seconds integer, remaining integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  policy control_plane.rate_limit_policies%ROWTYPE;
  window_start timestamptz;
  consumed integer;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO policy FROM control_plane.rate_limit_policies
  WHERE action = p_action AND enabled;
  IF NOT FOUND OR policy.request_limit <> p_limit OR policy.window_seconds <> p_window_seconds THEN
    RAISE EXCEPTION 'rate-limit policy is not recognised' USING ERRCODE = '22023';
  END IF;
  window_start := to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) / policy.window_seconds)
      * policy.window_seconds
  );
  INSERT INTO control_plane.rate_limit_buckets (
    tenant_id, actor_key, action, window_started_at, request_count
  ) VALUES (
    selected_tenant, 'user:' || actor::text, p_action, window_start, 1
  )
  ON CONFLICT (tenant_id, actor_key, action, window_started_at) DO UPDATE SET
    request_count = control_plane.rate_limit_buckets.request_count + 1,
    updated_at = now()
  RETURNING request_count INTO consumed;

  allowed := consumed <= policy.request_limit;
  remaining := greatest(policy.request_limit - consumed, 0);
  retry_after_seconds := CASE WHEN allowed THEN 0 ELSE greatest(
    1,
    ceil(extract(epoch FROM (window_start + make_interval(secs => policy.window_seconds) - clock_timestamp())))::integer
  ) END;
  IF NOT allowed AND policy.audit_excess AND consumed = policy.request_limit + 1 THEN
    INSERT INTO control_plane.audit_log (
      tenant_id, audit_id, actor_user_id, actor_type, action,
      resource_type, resource_id, audit_metadata
    ) VALUES (
      selected_tenant, control_plane.generate_ulid(), actor, 'user',
      'rate_limit.exceeded', 'rate_limit_policy', p_action,
      jsonb_build_object('retry_after_seconds', retry_after_seconds)
    );
  END IF;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_albert_turn(
  p_conversation_id text,
  p_turn_id text,
  p_provider_response_id text,
  p_usage jsonb,
  p_answer_state text,
  p_result_digest text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  selected_tenant text := control_plane.require_current_tenant_id();
BEGIN
  IF p_provider_response_id IS NULL OR length(btrim(p_provider_response_id)) NOT BETWEEN 1 AND 512
     OR p_usage IS NULL OR jsonb_typeof(p_usage) <> 'object'
     OR NOT EXISTS (
       SELECT 1 FROM control_plane.answer_state_lookup WHERE state = p_answer_state
     ) THEN
    RAISE EXCEPTION 'turn completion input is invalid' USING ERRCODE = '22023';
  END IF;

  UPDATE control_plane.conversation_turns AS turn
  SET status = 'completed',
      provider_response_id = p_provider_response_id,
      usage = p_usage,
      answer_state = p_answer_state,
      result_digest = p_result_digest,
      completed_at = now()
  FROM control_plane.conversations AS conversation
  WHERE turn.tenant_id = selected_tenant
    AND turn.turn_id = p_turn_id
    AND turn.conversation_id = p_conversation_id
    AND turn.status = 'running'
    AND turn.created_by = actor
    AND conversation.tenant_id = turn.tenant_id
    AND conversation.conversation_id = turn.conversation_id
    AND conversation.created_by = actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'running conversation turn was not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE control_plane.conversations
  SET updated_at = now()
  WHERE tenant_id = selected_tenant
    AND conversation_id = p_conversation_id;

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'conversation.turn_completed', 'conversation_turn', p_turn_id,
    jsonb_build_object('answer_state', p_answer_state, 'usage', p_usage)
  );
END;
$$;

-- M2 replaces these two functions with full operational projections after the
-- queue and ingestion metadata tables exist. Defining the operator boundary in
-- M1 allows role administration and access tests to ship before those tables.
CREATE OR REPLACE FUNCTION public.albert_operator_fleet()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE = '42501';
  END IF;
  RETURN '[]'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_operator_pipeline(p_tenant_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control_plane.tenants WHERE tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant was not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN '{}'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_operator_status()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT auth.uid() IS NOT NULL AND control_plane.is_internal_operator();
$$;

REVOKE ALL ON TABLE
  control_plane.internal_operators,
  control_plane.oauth_secret_envelopes,
  control_plane.oauth_sessions,
  control_plane.oauth_session_secret_envelopes,
  control_plane.operator_audit_log,
  control_plane.onboarding_question_responses,
  control_plane.identity_review_decisions,
  control_plane.conversation_turns,
  control_plane.conversation_turn_events,
  control_plane.model_usage_ledger,
  control_plane.rate_limit_buckets
FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE
  control_plane.internal_operators,
  control_plane.oauth_secret_envelopes,
  control_plane.oauth_sessions,
  control_plane.oauth_session_secret_envelopes,
  control_plane.operator_audit_log,
  control_plane.onboarding_question_responses,
  control_plane.identity_review_decisions,
  control_plane.conversation_turns,
  control_plane.conversation_turn_events,
  control_plane.model_usage_ledger,
  control_plane.rate_limit_buckets
TO service_role;

GRANT SELECT ON TABLE
  control_plane.oauth_sessions,
  control_plane.onboarding_question_responses,
  control_plane.identity_review_decisions
TO authenticated;

REVOKE ALL ON FUNCTION public.bootstrap_albert_tenant(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_albert_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_list_conversations(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_conversation_history(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_connections_workspace() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_answer_blocking_question(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_decide_identity_match(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_albert_turn(text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_answer_event_append(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_albert_turn(text, text, text, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_albert_turn(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_albert_model_usage(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_albert_rate_limit(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_operator_fleet() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_operator_pipeline(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_operator_status() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.bootstrap_albert_tenant(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_albert_context() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_list_conversations(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_conversation_history(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_connections_workspace() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_answer_blocking_question(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_decide_identity_match(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.begin_albert_turn(text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_answer_event_append(text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_albert_turn(text, text, text, jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_albert_turn(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_albert_model_usage(text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_albert_rate_limit(text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_operator_fleet() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_operator_pipeline(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_operator_status() TO authenticated;

COMMIT;
