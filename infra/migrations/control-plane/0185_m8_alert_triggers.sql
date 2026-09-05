BEGIN;

-- 0185: Heads-up alerts (ADR 0132).
--
-- Deterministic triggers evaluated over the governed Cube views by the
-- imessage-bridge under a short owner turn lease, then texted over Linq to
-- the enrolled numbers the owner picks per trigger. The trigger catalogue
-- (what each trigger watches, its queries and thresholds) lives in code
-- (services/alerts); the control plane stores each tenant's switches and
-- recipients, the latest evaluation result per trigger, every fired event
-- (deduplicated so a condition fires once) and the evaluation runs.
--
-- Access posture (as 0180/0183): reads for every active member; switching a
-- trigger, choosing its recipients and requesting a check are owner/manager
-- actions because an alert sends business data to a phone. Claim, record and
-- finish are called by the bridge's owner session. SECURITY DEFINER RPCs,
-- RLS on, no direct table policies. Lifecycle vocabularies are described
-- lookups (0061 shape).

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('alerts.mutation', 60, 60, false),
  ('alerts.check', 12, 3600, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess,
  enabled = true;

CREATE TABLE IF NOT EXISTS control_plane.alert_event_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.alert_event_status_lookup (status, description) VALUES
  ('queued', 'Fired by an evaluation; the bridge has not delivered it yet.'),
  ('sent', 'Delivered over Linq to every recipient of the trigger.'),
  ('failed', 'Delivery failed; the error is recorded on the event.'),
  ('muted', 'Fired while the trigger had no recipients; shown in the Alerts tab, never texted.')
ON CONFLICT (status) DO UPDATE SET description = EXCLUDED.description;

REVOKE ALL ON TABLE control_plane.alert_event_status_lookup FROM PUBLIC;
REVOKE ALL ON TABLE control_plane.alert_event_status_lookup FROM anon;
REVOKE ALL ON TABLE control_plane.alert_event_status_lookup FROM authenticated;

CREATE TABLE IF NOT EXISTS control_plane.alert_evaluation_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.alert_evaluation_status_lookup (status, description) VALUES
  ('queued', 'A check the owner requested; the bridge has not picked it up yet.'),
  ('running', 'The bridge is evaluating the triggers under an owner turn lease.'),
  ('finished', 'Every enabled trigger was evaluated; fired events are recorded.'),
  ('failed', 'The evaluation stopped early; the error is recorded.')
ON CONFLICT (status) DO UPDATE SET description = EXCLUDED.description;

REVOKE ALL ON TABLE control_plane.alert_evaluation_status_lookup FROM PUBLIC;
REVOKE ALL ON TABLE control_plane.alert_evaluation_status_lookup FROM anon;
REVOKE ALL ON TABLE control_plane.alert_evaluation_status_lookup FROM authenticated;

-- One row per trigger the owner has touched; a trigger without a row is on
-- and goes to the owner's enrolled number (the catalogue default).
CREATE TABLE IF NOT EXISTS control_plane.alert_triggers (
  tenant_id text NOT NULL,
  trigger_key text NOT NULL CHECK (trigger_key ~ '^[a-z][a-z0-9_]{2,60}$'),
  enabled boolean NOT NULL DEFAULT true,
  recipients text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(recipients) <= 20),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (tenant_id, trigger_key)
);
ALTER TABLE control_plane.alert_triggers ENABLE ROW LEVEL SECURITY;

-- The latest evaluation of each trigger, for the tab's "right now" line.
CREATE TABLE IF NOT EXISTS control_plane.alert_trigger_state (
  tenant_id text NOT NULL,
  trigger_key text NOT NULL CHECK (trigger_key ~ '^[a-z][a-z0-9_]{2,60}$'),
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(last_result) = 'object'),
  last_fired_at timestamptz,
  PRIMARY KEY (tenant_id, trigger_key)
);
ALTER TABLE control_plane.alert_trigger_state ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS control_plane.alert_evaluations (
  tenant_id text NOT NULL,
  evaluation_id text NOT NULL DEFAULT control_plane.generate_ulid(),
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status text NOT NULL REFERENCES control_plane.alert_evaluation_status_lookup(status),
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  conversation_id text,
  turn_id text,
  freshness_digest text CHECK (freshness_digest IS NULL OR length(freshness_digest) <= 120),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  error text CHECK (error IS NULL OR length(error) <= 400),
  PRIMARY KEY (tenant_id, evaluation_id)
);
CREATE INDEX IF NOT EXISTS alert_evaluations_recent
  ON control_plane.alert_evaluations (tenant_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS alert_evaluations_open
  ON control_plane.alert_evaluations (tenant_id, status)
  WHERE status IN ('queued', 'running');
ALTER TABLE control_plane.alert_evaluations ENABLE ROW LEVEL SECURITY;

-- Every fired alert. The dedupe key is the trigger's own identity for the
-- condition (an item, a job, a day, a customer and a date), so a condition
-- that is still true at the next evaluation does not fire again.
CREATE TABLE IF NOT EXISTS control_plane.alert_events (
  tenant_id text NOT NULL,
  event_id text NOT NULL DEFAULT control_plane.generate_ulid(),
  trigger_key text NOT NULL CHECK (trigger_key ~ '^[a-z][a-z0-9_]{2,60}$'),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  headline text NOT NULL CHECK (length(headline) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  status text NOT NULL REFERENCES control_plane.alert_event_status_lookup(status),
  recipients text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(recipients) <= 20),
  evaluation_id text,
  fired_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  error text CHECK (error IS NULL OR length(error) <= 400),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, trigger_key, dedupe_key)
);
CREATE INDEX IF NOT EXISTS alert_events_recent
  ON control_plane.alert_events (tenant_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS alert_events_queued
  ON control_plane.alert_events (tenant_id, status)
  WHERE status = 'queued';
ALTER TABLE control_plane.alert_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS control_plane.alert_settings (
  tenant_id text PRIMARY KEY,
  cadence_minutes integer NOT NULL DEFAULT 60 CHECK (cadence_minutes BETWEEN 15 AND 1440),
  last_evaluated_at timestamptz,
  last_freshness_digest text CHECK (last_freshness_digest IS NULL OR length(last_freshness_digest) <= 120),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE control_plane.alert_settings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.alert_trigger_json(trigger_row control_plane.alert_triggers)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'triggerKey', trigger_row.trigger_key,
    'enabled', trigger_row.enabled,
    'recipients', to_jsonb(trigger_row.recipients),
    'config', trigger_row.config,
    'updatedAt', trigger_row.updated_at
  );
$$;

CREATE OR REPLACE FUNCTION control_plane.alert_state_json(state control_plane.alert_trigger_state)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'triggerKey', state.trigger_key,
    'lastEvaluatedAt', state.last_evaluated_at,
    'lastResult', state.last_result,
    'lastFiredAt', state.last_fired_at
  );
$$;

CREATE OR REPLACE FUNCTION control_plane.alert_event_json(event control_plane.alert_events)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'eventId', event.event_id,
    'triggerKey', event.trigger_key,
    'dedupeKey', event.dedupe_key,
    'headline', event.headline,
    'body', event.body,
    'evidence', event.evidence,
    'status', event.status,
    'recipients', to_jsonb(event.recipients),
    'evaluationId', event.evaluation_id,
    'firedAt', event.fired_at,
    'deliveredAt', event.delivered_at,
    'error', event.error
  );
$$;

CREATE OR REPLACE FUNCTION control_plane.alert_evaluation_json(evaluation control_plane.alert_evaluations)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'evaluationId', evaluation.evaluation_id,
    'trigger', evaluation.trigger,
    'status', evaluation.status,
    'requestedAt', evaluation.requested_at,
    'startedAt', evaluation.started_at,
    'finishedAt', evaluation.finished_at,
    'conversationId', evaluation.conversation_id,
    'turnId', evaluation.turn_id,
    'freshnessDigest', evaluation.freshness_digest,
    'summary', evaluation.summary,
    'error', evaluation.error
  );
$$;

CREATE OR REPLACE FUNCTION control_plane.alert_settings_json(p_tenant_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT coalesce((
    SELECT jsonb_build_object(
      'cadenceMinutes', settings.cadence_minutes,
      'lastEvaluatedAt', settings.last_evaluated_at,
      'lastFreshnessDigest', settings.last_freshness_digest
    )
    FROM control_plane.alert_settings AS settings
    WHERE settings.tenant_id = p_tenant_id
  ), jsonb_build_object('cadenceMinutes', 60, 'lastEvaluatedAt', NULL, 'lastFreshnessDigest', NULL));
$$;

-- Evaluations abandoned by a bridge that stopped mid-run, or never picked up,
-- are closed so they neither block the next check nor show as running forever.
CREATE OR REPLACE FUNCTION control_plane.alert_evaluations_sweep(p_tenant_id text)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog
AS $$
  UPDATE control_plane.alert_evaluations SET
    status = 'failed',
    finished_at = clock_timestamp(),
    error = CASE
      WHEN status = 'running' THEN 'The bridge stopped before this check finished.'
      ELSE 'The bridge did not pick this check up within an hour.'
    END
  WHERE tenant_id = p_tenant_id
    AND (
      (status = 'running' AND coalesce(started_at, requested_at) < clock_timestamp() - interval '20 minutes')
      OR (status = 'queued' AND requested_at < clock_timestamp() - interval '60 minutes')
    );
$$;

-- Read: any active member — the Alerts tab.
CREATE OR REPLACE FUNCTION public.albert_alerts_workspace()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
BEGIN
  PERFORM control_plane.alert_evaluations_sweep(v_tenant_id);
  RETURN jsonb_build_object(
    'settings', control_plane.alert_settings_json(v_tenant_id),
    'triggers', coalesce((
      SELECT jsonb_agg(control_plane.alert_trigger_json(trigger_row) ORDER BY trigger_row.trigger_key)
      FROM control_plane.alert_triggers AS trigger_row
      WHERE trigger_row.tenant_id = v_tenant_id
    ), '[]'::jsonb),
    'states', coalesce((
      SELECT jsonb_agg(control_plane.alert_state_json(state) ORDER BY state.trigger_key)
      FROM control_plane.alert_trigger_state AS state
      WHERE state.tenant_id = v_tenant_id
    ), '[]'::jsonb),
    'events', coalesce((
      SELECT jsonb_agg(control_plane.alert_event_json(recent) ORDER BY recent.fired_at DESC)
      FROM (
        SELECT event.*
        FROM control_plane.alert_events AS event
        WHERE event.tenant_id = v_tenant_id
        ORDER BY event.fired_at DESC
        LIMIT 60
      ) AS recent
    ), '[]'::jsonb),
    'lastEvaluation', (
      SELECT control_plane.alert_evaluation_json(evaluation)
      FROM control_plane.alert_evaluations AS evaluation
      WHERE evaluation.tenant_id = v_tenant_id
        AND evaluation.status IN ('finished', 'failed')
      ORDER BY evaluation.requested_at DESC
      LIMIT 1
    ),
    'openEvaluation', (
      SELECT control_plane.alert_evaluation_json(evaluation)
      FROM control_plane.alert_evaluations AS evaluation
      WHERE evaluation.tenant_id = v_tenant_id
        AND evaluation.status IN ('queued', 'running')
      ORDER BY evaluation.requested_at DESC
      LIMIT 1
    )
  );
END;
$$;

-- Switch a trigger and choose who receives it. Owner/manager. Every
-- recipient must be an enabled enrolment of the tenant: enrolment is the
-- boundary that decides which numbers may receive the business's data.
CREATE OR REPLACE FUNCTION public.albert_alerts_trigger_save(
  p_trigger_key text,
  p_enabled boolean,
  p_recipients jsonb,
  p_config jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
  v_actor uuid := extensions.albert_auth_uid();
  v_recipients text[];
  v_row control_plane.alert_triggers%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for managing alerts' USING ERRCODE = '42501';
  END IF;
  IF p_trigger_key IS NULL OR p_trigger_key !~ '^[a-z][a-z0-9_]{2,60}$' THEN
    RAISE EXCEPTION 'alert trigger key is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_recipients IS NULL OR jsonb_typeof(p_recipients) <> 'array' THEN
    RAISE EXCEPTION 'alert recipients must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF p_config IS NOT NULL AND jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'alert config must be a JSON object' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(DISTINCT phone ORDER BY phone), '{}'::text[]) INTO v_recipients
    FROM (
      SELECT regexp_replace(value, '[\s().-]', '', 'g') AS phone
      FROM jsonb_array_elements_text(p_recipients) AS value
    ) AS cleaned;
  IF cardinality(v_recipients) > 20 THEN
    RAISE EXCEPTION 'an alert can have at most 20 recipients' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_recipients) AS phone WHERE phone !~ '^\+[1-9][0-9]{5,14}$'
  ) THEN
    RAISE EXCEPTION 'phone number must be E.164, like +61414187820' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_recipients) AS phone
    WHERE NOT EXISTS (
      SELECT 1 FROM control_plane.tenant_imessage_enrollments AS enrollment
      WHERE enrollment.tenant_id = v_tenant_id
        AND enrollment.phone_e164 = phone
        AND enrollment.enabled
    )
  ) THEN
    RAISE EXCEPTION 'that number is not enrolled for iMessage' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.alert_triggers (
    tenant_id, trigger_key, enabled, recipients, config, created_by, updated_by
  ) VALUES (
    v_tenant_id, p_trigger_key, coalesce(p_enabled, true), v_recipients, coalesce(p_config, '{}'::jsonb), v_actor, v_actor
  )
  ON CONFLICT (tenant_id, trigger_key) DO UPDATE SET
    enabled = coalesce(p_enabled, control_plane.alert_triggers.enabled),
    recipients = v_recipients,
    config = coalesce(p_config, control_plane.alert_triggers.config),
    updated_at = clock_timestamp(),
    updated_by = v_actor
  RETURNING * INTO v_row;
  RETURN control_plane.alert_trigger_json(v_row);
END;
$$;

-- Queue a check ("Check now"). Owner/manager. One open evaluation at a time.
CREATE OR REPLACE FUNCTION public.albert_alerts_check_request(p_evaluation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
  v_actor uuid := extensions.albert_auth_uid();
  v_row control_plane.alert_evaluations%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for checking alerts' USING ERRCODE = '42501';
  END IF;
  IF p_evaluation_id IS NULL OR p_evaluation_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$' THEN
    RAISE EXCEPTION 'evaluation id must be a ULID' USING ERRCODE = '22023';
  END IF;
  PERFORM control_plane.alert_evaluations_sweep(v_tenant_id);
  IF EXISTS (
    SELECT 1 FROM control_plane.alert_evaluations
    WHERE tenant_id = v_tenant_id AND status IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'a check is already in progress' USING ERRCODE = '55000';
  END IF;
  INSERT INTO control_plane.alert_evaluations (
    tenant_id, evaluation_id, trigger, status, requested_by
  ) VALUES (
    v_tenant_id, p_evaluation_id, 'manual', 'queued', v_actor
  )
  RETURNING * INTO v_row;
  RETURN control_plane.alert_evaluation_json(v_row);
END;
$$;

-- The bridge's work list: the queued manual check if any, whether a
-- scheduled evaluation is due, the trigger rows and the settings. Any
-- active member (the bridge runs as the owner).
CREATE OR REPLACE FUNCTION public.albert_alerts_work()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_open boolean;
  v_due boolean;
BEGIN
  PERFORM control_plane.alert_evaluations_sweep(v_tenant_id);
  SELECT EXISTS (
    SELECT 1 FROM control_plane.alert_evaluations
    WHERE tenant_id = v_tenant_id AND status IN ('queued', 'running')
  ) INTO v_open;
  SELECT coalesce((
    SELECT settings.last_evaluated_at IS NULL
      OR settings.last_evaluated_at < clock_timestamp() - make_interval(mins => settings.cadence_minutes)
    FROM control_plane.alert_settings AS settings
    WHERE settings.tenant_id = v_tenant_id
  ), true) INTO v_due;
  RETURN jsonb_build_object(
    'queued', (
      SELECT control_plane.alert_evaluation_json(evaluation)
      FROM control_plane.alert_evaluations AS evaluation
      WHERE evaluation.tenant_id = v_tenant_id AND evaluation.status = 'queued'
      ORDER BY evaluation.requested_at ASC
      LIMIT 1
    ),
    'due', v_due AND NOT v_open,
    'settings', control_plane.alert_settings_json(v_tenant_id),
    'triggers', coalesce((
      SELECT jsonb_agg(control_plane.alert_trigger_json(trigger_row) ORDER BY trigger_row.trigger_key)
      FROM control_plane.alert_triggers AS trigger_row
      WHERE trigger_row.tenant_id = v_tenant_id
    ), '[]'::jsonb),
    'states', coalesce((
      SELECT jsonb_agg(control_plane.alert_state_json(state) ORDER BY state.trigger_key)
      FROM control_plane.alert_trigger_state AS state
      WHERE state.tenant_id = v_tenant_id
    ), '[]'::jsonb)
  );
END;
$$;

-- Claim one evaluation. A manual check flips queued → running; a scheduled
-- evaluation inserts a running row when nothing is open. Returns the
-- evaluation, or NULL when there was nothing to claim.
CREATE OR REPLACE FUNCTION public.albert_alerts_evaluation_claim(
  p_evaluation_id text,
  p_trigger text,
  p_conversation_id text,
  p_turn_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_row control_plane.alert_evaluations%ROWTYPE;
BEGIN
  IF p_trigger NOT IN ('schedule', 'manual') THEN
    RAISE EXCEPTION 'unknown evaluation trigger' USING ERRCODE = '22023';
  END IF;
  IF p_evaluation_id IS NULL OR p_evaluation_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$' THEN
    RAISE EXCEPTION 'evaluation id must be a ULID' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('alerts:' || v_tenant_id));
  IF p_trigger = 'manual' THEN
    UPDATE control_plane.alert_evaluations SET
      status = 'running',
      started_at = clock_timestamp(),
      conversation_id = p_conversation_id,
      turn_id = p_turn_id
    WHERE tenant_id = v_tenant_id AND evaluation_id = p_evaluation_id AND status = 'queued'
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    RETURN control_plane.alert_evaluation_json(v_row);
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.alert_evaluations
    WHERE tenant_id = v_tenant_id AND status IN ('queued', 'running')
  ) THEN
    RETURN NULL;
  END IF;
  INSERT INTO control_plane.alert_evaluations (
    tenant_id, evaluation_id, trigger, status, requested_at, started_at, conversation_id, turn_id
  ) VALUES (
    v_tenant_id, p_evaluation_id, 'schedule', 'running', clock_timestamp(), clock_timestamp(), p_conversation_id, p_turn_id
  )
  RETURNING * INTO v_row;
  RETURN control_plane.alert_evaluation_json(v_row);
END;
$$;

-- Record one trigger's result: the latest state for the tab, and the
-- events it fired. An event whose dedupe key already exists is dropped
-- (the condition fired before). Returns the events actually recorded.
CREATE OR REPLACE FUNCTION public.albert_alerts_record_result(
  p_evaluation_id text,
  p_trigger_key text,
  p_result jsonb,
  p_events jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_event jsonb;
  v_recipients text[];
  v_row control_plane.alert_events%ROWTYPE;
  v_recorded jsonb := '[]'::jsonb;
BEGIN
  IF p_trigger_key IS NULL OR p_trigger_key !~ '^[a-z][a-z0-9_]{2,60}$' THEN
    RAISE EXCEPTION 'alert trigger key is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' THEN
    RAISE EXCEPTION 'alert result must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'alert events must be a JSON array' USING ERRCODE = '22023';
  END IF;
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    SELECT coalesce(array_agg(value), '{}'::text[]) INTO v_recipients
      FROM jsonb_array_elements_text(coalesce(v_event->'recipients', '[]'::jsonb)) AS value
      WHERE value ~ '^\+[1-9][0-9]{5,14}$';
    INSERT INTO control_plane.alert_events (
      tenant_id, trigger_key, dedupe_key, headline, body, evidence, status, recipients, evaluation_id
    ) VALUES (
      v_tenant_id,
      p_trigger_key,
      left(v_event->>'dedupeKey', 200),
      left(v_event->>'headline', 200),
      left(v_event->>'body', 2000),
      CASE WHEN jsonb_typeof(v_event->'evidence') = 'object' THEN v_event->'evidence' ELSE '{}'::jsonb END,
      CASE WHEN cardinality(v_recipients) = 0 THEN 'muted' ELSE 'queued' END,
      v_recipients,
      p_evaluation_id
    )
    ON CONFLICT (tenant_id, trigger_key, dedupe_key) DO NOTHING
    RETURNING * INTO v_row;
    IF FOUND THEN
      v_recorded := v_recorded || control_plane.alert_event_json(v_row);
    END IF;
  END LOOP;
  INSERT INTO control_plane.alert_trigger_state (tenant_id, trigger_key, last_evaluated_at, last_result, last_fired_at)
  VALUES (
    v_tenant_id, p_trigger_key, clock_timestamp(), p_result,
    CASE WHEN jsonb_array_length(v_recorded) > 0 THEN clock_timestamp() ELSE NULL END
  )
  ON CONFLICT (tenant_id, trigger_key) DO UPDATE SET
    last_evaluated_at = clock_timestamp(),
    last_result = p_result,
    last_fired_at = CASE
      WHEN jsonb_array_length(v_recorded) > 0 THEN clock_timestamp()
      ELSE control_plane.alert_trigger_state.last_fired_at
    END;
  RETURN v_recorded;
END;
$$;

-- Record an event's delivery outcome. Owner session (the bridge).
CREATE OR REPLACE FUNCTION public.albert_alerts_event_finish(
  p_event_id text,
  p_status text,
  p_error text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_row control_plane.alert_events%ROWTYPE;
BEGIN
  IF p_status NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'an alert finishes as sent or failed' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.alert_events SET
    status = p_status,
    delivered_at = CASE WHEN p_status = 'sent' THEN clock_timestamp() ELSE delivered_at END,
    error = left(p_error, 400)
  WHERE tenant_id = v_tenant_id AND event_id = p_event_id AND status = 'queued'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no queued alert to finish' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.alert_event_json(v_row);
END;
$$;

-- Record an evaluation's outcome and stamp the settings so the next
-- scheduled evaluation waits a full cadence. Owner session (the bridge).
CREATE OR REPLACE FUNCTION public.albert_alerts_evaluation_finish(
  p_evaluation_id text,
  p_status text,
  p_summary jsonb,
  p_error text,
  p_freshness_digest text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_row control_plane.alert_evaluations%ROWTYPE;
BEGIN
  IF p_status NOT IN ('finished', 'failed') THEN
    RAISE EXCEPTION 'an evaluation finishes as finished or failed' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.alert_evaluations SET
    status = p_status,
    finished_at = clock_timestamp(),
    summary = CASE WHEN jsonb_typeof(p_summary) = 'object' THEN p_summary ELSE '{}'::jsonb END,
    error = left(p_error, 400),
    freshness_digest = left(p_freshness_digest, 120)
  WHERE tenant_id = v_tenant_id AND evaluation_id = p_evaluation_id AND status = 'running'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no running evaluation to finish' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO control_plane.alert_settings (tenant_id, last_evaluated_at, last_freshness_digest, updated_at)
  VALUES (v_tenant_id, clock_timestamp(), left(p_freshness_digest, 120), clock_timestamp())
  ON CONFLICT (tenant_id) DO UPDATE SET
    last_evaluated_at = clock_timestamp(),
    last_freshness_digest = coalesce(left(p_freshness_digest, 120), control_plane.alert_settings.last_freshness_digest),
    updated_at = clock_timestamp();
  RETURN control_plane.alert_evaluation_json(v_row);
END;
$$;

REVOKE ALL ON FUNCTION control_plane.alert_trigger_json(control_plane.alert_triggers) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.alert_state_json(control_plane.alert_trigger_state) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.alert_event_json(control_plane.alert_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.alert_evaluation_json(control_plane.alert_evaluations) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.alert_settings_json(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.alert_evaluations_sweep(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_alerts_workspace() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_alerts_trigger_save(text, boolean, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_alerts_check_request(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_alerts_work() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_alerts_evaluation_claim(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_alerts_record_result(text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_alerts_event_finish(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_alerts_evaluation_finish(text, text, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_alerts_workspace() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_alerts_trigger_save(text, boolean, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_alerts_check_request(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_alerts_work() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_alerts_evaluation_claim(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_alerts_record_result(text, text, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_alerts_event_finish(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_alerts_evaluation_finish(text, text, jsonb, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
