-- 0183: Scheduled reports (ADR 0131).
--
-- The owner describes a recurring iMessage report in plain language; the
-- web tier turns it into a schedule (a local time of day, the weekdays it
-- runs, an IANA zone, the enrolled number it goes to, and the standing
-- question Albert answers). The imessage-bridge scheduler polls for due
-- schedules and queued manual runs through the owner session, claims each
-- run atomically, runs the Omni analysis and texts the answer through Linq.
--
-- Access posture (as 0180): reads for every active member; creating,
-- editing, deleting and manually running a schedule are owner/manager
-- actions because a run executes with the owner's full analytical surface
-- and sends business data to a phone. Claim/finish are called by the
-- bridge's owner session, which is an owner. SECURITY DEFINER RPCs, RLS
-- on, no direct table policies.

BEGIN;

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('scheduled.create', 20, 3600, false),
  ('scheduled.mutation', 60, 60, false),
  ('scheduled.run', 12, 3600, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess,
  enabled = true;

CREATE TABLE IF NOT EXISTS control_plane.scheduled_tasks (
  tenant_id text NOT NULL,
  task_id text NOT NULL DEFAULT control_plane.generate_ulid(),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  -- What the owner typed; kept so the card can show it and a later edit can re-read it.
  request_text text NOT NULL CHECK (length(request_text) BETWEEN 1 AND 2000),
  -- The standing question every run answers.
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 2000),
  time_of_day time NOT NULL,
  days text[] NOT NULL CHECK (
    cardinality(days) BETWEEN 1 AND 7
    AND days <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']::text[]
  ),
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 80),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{5,14}$'),
  enabled boolean NOT NULL DEFAULT true,
  -- The next instant the schedule fires; NULL while disabled. Computed by
  -- the callers (one shared implementation) and advanced at claim time so
  -- a long run is never claimed twice.
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (tenant_id, task_id)
);
CREATE INDEX IF NOT EXISTS scheduled_tasks_due
  ON control_plane.scheduled_tasks (next_run_at)
  WHERE enabled AND next_run_at IS NOT NULL;
ALTER TABLE control_plane.scheduled_tasks ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS control_plane.scheduled_task_runs (
  tenant_id text NOT NULL,
  run_id text NOT NULL DEFAULT control_plane.generate_ulid(),
  task_id text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'sent', 'failed', 'missed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  -- The slot a scheduled run represents (the task's next_run_at when claimed).
  scheduled_for timestamptz,
  conversation_id text,
  turn_id text,
  answer_state text CHECK (answer_state IS NULL OR length(answer_state) <= 40),
  summary text CHECK (summary IS NULL OR length(summary) <= 400),
  error text CHECK (error IS NULL OR length(error) <= 400),
  bubbles integer CHECK (bubbles IS NULL OR bubbles >= 0),
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, task_id)
    REFERENCES control_plane.scheduled_tasks (tenant_id, task_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS scheduled_task_runs_by_task
  ON control_plane.scheduled_task_runs (tenant_id, task_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS scheduled_task_runs_open
  ON control_plane.scheduled_task_runs (tenant_id, status)
  WHERE status IN ('queued', 'running');
ALTER TABLE control_plane.scheduled_task_runs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.scheduled_run_json(run control_plane.scheduled_task_runs)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'runId', run.run_id,
    'taskId', run.task_id,
    'trigger', run.trigger,
    'status', run.status,
    'requestedAt', run.requested_at,
    'startedAt', run.started_at,
    'finishedAt', run.finished_at,
    'scheduledFor', run.scheduled_for,
    'conversationId', run.conversation_id,
    'turnId', run.turn_id,
    'answerState', run.answer_state,
    'summary', run.summary,
    'error', run.error,
    'bubbles', run.bubbles
  );
$$;

CREATE OR REPLACE FUNCTION control_plane.scheduled_task_json(task control_plane.scheduled_tasks)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'taskId', task.task_id,
    'title', task.title,
    'requestText', task.request_text,
    'prompt', task.prompt,
    'timeOfDay', to_char(task.time_of_day, 'HH24:MI'),
    'days', to_jsonb(task.days),
    'timezone', task.timezone,
    'phone', task.phone_e164,
    'enabled', task.enabled,
    'nextRunAt', task.next_run_at,
    'lastRunAt', task.last_run_at,
    'createdAt', task.created_at,
    'updatedAt', task.updated_at
  );
$$;

-- The task plus its last run and the five most recent runs, for the UI.
CREATE OR REPLACE FUNCTION control_plane.scheduled_task_detail_json(task control_plane.scheduled_tasks)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT control_plane.scheduled_task_json(task) || jsonb_build_object(
    'lastRun', (
      SELECT control_plane.scheduled_run_json(run)
      FROM control_plane.scheduled_task_runs AS run
      WHERE run.tenant_id = task.tenant_id AND run.task_id = task.task_id
      ORDER BY run.requested_at DESC
      LIMIT 1
    ),
    'recentRuns', coalesce((
      SELECT jsonb_agg(control_plane.scheduled_run_json(recent) ORDER BY recent.requested_at DESC)
      FROM (
        SELECT run.*
        FROM control_plane.scheduled_task_runs AS run
        WHERE run.tenant_id = task.tenant_id AND run.task_id = task.task_id
        ORDER BY run.requested_at DESC
        LIMIT 5
      ) AS recent
    ), '[]'::jsonb)
  );
$$;

-- Runs abandoned by a bridge that stopped mid-run (or never picked a queued
-- manual run up) are closed so they neither block the next slot nor show as
-- running forever. Called from the read paths, so the UI heals itself.
CREATE OR REPLACE FUNCTION control_plane.scheduled_runs_sweep(p_tenant_id text)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog
AS $$
  UPDATE control_plane.scheduled_task_runs SET
    status = 'failed',
    finished_at = clock_timestamp(),
    error = CASE
      WHEN status = 'running' THEN 'The scheduler stopped before this run finished.'
      ELSE 'The scheduler did not pick this run up within an hour.'
    END
  WHERE tenant_id = p_tenant_id
    AND (
      (status = 'running' AND coalesce(started_at, requested_at) < clock_timestamp() - interval '30 minutes')
      OR (status = 'queued' AND requested_at < clock_timestamp() - interval '60 minutes')
    );
$$;

-- Read: any active member — the Scheduled tab.
CREATE OR REPLACE FUNCTION public.albert_scheduled_workspace()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
BEGIN
  PERFORM control_plane.scheduled_runs_sweep(v_tenant_id);
  RETURN jsonb_build_object(
    'tasks', coalesce((
      SELECT jsonb_agg(control_plane.scheduled_task_detail_json(task) ORDER BY task.created_at ASC)
      FROM control_plane.scheduled_tasks AS task
      WHERE task.tenant_id = v_tenant_id
    ), '[]'::jsonb)
  );
END;
$$;

-- Create (p_task_id NULL) or replace one schedule. Owner/manager. The
-- destination must be an enabled enrolment of the tenant: enrolment is the
-- boundary that decides which numbers may receive the business's data.
CREATE OR REPLACE FUNCTION public.albert_scheduled_task_save(
  p_task_id text,
  p_title text,
  p_request_text text,
  p_prompt text,
  p_time_of_day text,
  p_days jsonb,
  p_timezone text,
  p_phone text,
  p_enabled boolean,
  p_next_run_at timestamptz
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
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g');
  v_days text[];
  v_count integer;
  v_row control_plane.scheduled_tasks%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for managing schedules' USING ERRCODE = '42501';
  END IF;
  IF p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'schedule title must be 1-80 characters' USING ERRCODE = '22023';
  END IF;
  IF p_request_text IS NULL OR length(p_request_text) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'schedule request text must be 1-2000 characters' USING ERRCODE = '22023';
  END IF;
  IF p_prompt IS NULL OR length(btrim(p_prompt)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'schedule prompt must be 1-2000 characters' USING ERRCODE = '22023';
  END IF;
  IF p_time_of_day IS NULL OR p_time_of_day !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RAISE EXCEPTION 'schedule time must be HH:MM' USING ERRCODE = '22023';
  END IF;
  IF p_days IS NULL OR jsonb_typeof(p_days) <> 'array' THEN
    RAISE EXCEPTION 'schedule days must be a JSON array' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT day ORDER BY day) INTO v_days
    FROM jsonb_array_elements_text(p_days) AS day
    WHERE day IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun');
  IF v_days IS NULL OR cardinality(v_days) = 0 THEN
    RAISE EXCEPTION 'schedule needs at least one day' USING ERRCODE = '22023';
  END IF;
  IF p_timezone IS NULL OR length(btrim(p_timezone)) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'schedule timezone is required' USING ERRCODE = '22023';
  END IF;
  IF v_phone !~ '^\+[1-9][0-9]{5,14}$' THEN
    RAISE EXCEPTION 'phone number must be E.164, like +61414187820' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.tenant_imessage_enrollments AS enrollment
    WHERE enrollment.tenant_id = v_tenant_id
      AND enrollment.phone_e164 = v_phone
      AND enrollment.enabled
  ) THEN
    RAISE EXCEPTION 'that number is not enrolled for iMessage' USING ERRCODE = '22023';
  END IF;
  IF p_enabled AND p_next_run_at IS NULL THEN
    RAISE EXCEPTION 'an enabled schedule needs its next run time' USING ERRCODE = '22023';
  END IF;

  IF p_task_id IS NULL THEN
    SELECT count(*) INTO v_count
      FROM control_plane.scheduled_tasks
      WHERE tenant_id = v_tenant_id;
    IF v_count >= 20 THEN
      RAISE EXCEPTION 'this organisation already has 20 schedules; remove one first' USING ERRCODE = '54000';
    END IF;
    INSERT INTO control_plane.scheduled_tasks (
      tenant_id, title, request_text, prompt, time_of_day, days, timezone, phone_e164,
      enabled, next_run_at, created_by, updated_by
    ) VALUES (
      v_tenant_id, btrim(p_title), p_request_text, btrim(p_prompt), p_time_of_day::time, v_days,
      btrim(p_timezone), v_phone,
      p_enabled, CASE WHEN p_enabled THEN p_next_run_at ELSE NULL END, v_actor, v_actor
    )
    RETURNING * INTO v_row;
  ELSE
    UPDATE control_plane.scheduled_tasks SET
      title = btrim(p_title),
      request_text = p_request_text,
      prompt = btrim(p_prompt),
      time_of_day = p_time_of_day::time,
      days = v_days,
      timezone = btrim(p_timezone),
      phone_e164 = v_phone,
      enabled = p_enabled,
      next_run_at = CASE WHEN p_enabled THEN p_next_run_at ELSE NULL END,
      updated_at = clock_timestamp(),
      updated_by = v_actor
    WHERE tenant_id = v_tenant_id AND task_id = p_task_id
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such schedule' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN control_plane.scheduled_task_detail_json(v_row);
END;
$$;

-- Remove one schedule and its run history. Owner/manager.
CREATE OR REPLACE FUNCTION public.albert_scheduled_task_delete(p_task_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for managing schedules' USING ERRCODE = '42501';
  END IF;
  DELETE FROM control_plane.scheduled_tasks
  WHERE tenant_id = v_tenant_id AND task_id = p_task_id;
  RETURN FOUND;
END;
$$;

-- Queue a manual run ("Run now"). Owner/manager. One open run per schedule.
CREATE OR REPLACE FUNCTION public.albert_scheduled_run_request(
  p_task_id text,
  p_run_id text
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
  v_run control_plane.scheduled_task_runs%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for running schedules' USING ERRCODE = '42501';
  END IF;
  IF p_run_id IS NULL OR p_run_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$' THEN
    RAISE EXCEPTION 'run id must be a ULID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.scheduled_tasks
    WHERE tenant_id = v_tenant_id AND task_id = p_task_id
  ) THEN
    RAISE EXCEPTION 'no such schedule' USING ERRCODE = 'P0002';
  END IF;
  PERFORM control_plane.scheduled_runs_sweep(v_tenant_id);
  IF EXISTS (
    SELECT 1 FROM control_plane.scheduled_task_runs
    WHERE tenant_id = v_tenant_id AND task_id = p_task_id AND status IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'a run is already in progress for this schedule' USING ERRCODE = '55000';
  END IF;
  INSERT INTO control_plane.scheduled_task_runs (
    tenant_id, run_id, task_id, trigger, status, requested_by
  ) VALUES (
    v_tenant_id, p_run_id, p_task_id, 'manual', 'queued', v_actor
  )
  RETURNING * INTO v_run;
  RETURN control_plane.scheduled_run_json(v_run);
END;
$$;

-- The scheduler's work list: due schedules and queued manual runs, each
-- with its task. Any active member (the bridge runs as the owner).
CREATE OR REPLACE FUNCTION public.albert_scheduled_work()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
BEGIN
  PERFORM control_plane.scheduled_runs_sweep(v_tenant_id);
  RETURN jsonb_build_object(
    'due', coalesce((
      SELECT jsonb_agg(control_plane.scheduled_task_json(task) ORDER BY task.next_run_at ASC)
      FROM control_plane.scheduled_tasks AS task
      WHERE task.tenant_id = v_tenant_id
        AND task.enabled
        AND task.next_run_at IS NOT NULL
        AND task.next_run_at <= clock_timestamp()
        AND NOT EXISTS (
          SELECT 1 FROM control_plane.scheduled_task_runs AS open
          WHERE open.tenant_id = task.tenant_id
            AND open.task_id = task.task_id
            AND open.status IN ('queued', 'running')
        )
    ), '[]'::jsonb),
    'queued', coalesce((
      SELECT jsonb_agg(
        control_plane.scheduled_run_json(run) || jsonb_build_object('task', control_plane.scheduled_task_json(task))
        ORDER BY run.requested_at ASC
      )
      FROM control_plane.scheduled_task_runs AS run
      JOIN control_plane.scheduled_tasks AS task
        ON task.tenant_id = run.tenant_id AND task.task_id = run.task_id
      WHERE run.tenant_id = v_tenant_id AND run.status = 'queued'
    ), '[]'::jsonb)
  );
END;
$$;

-- Claim one run atomically. For a scheduled trigger the task must still be
-- due with the next_run_at the caller read (an edit in between makes the
-- claim miss, and the next tick sees the new slot); the slot is recorded on
-- the run and next_run_at advances immediately so a long run is claimed
-- once. For a manual trigger the queued run flips to running. Returns the
-- run, or NULL when there was nothing to claim.
CREATE OR REPLACE FUNCTION public.albert_scheduled_run_claim(
  p_task_id text,
  p_run_id text,
  p_trigger text,
  p_expected_next_run_at timestamptz,
  p_next_run_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_task control_plane.scheduled_tasks%ROWTYPE;
  v_run control_plane.scheduled_task_runs%ROWTYPE;
BEGIN
  IF p_trigger NOT IN ('schedule', 'manual') THEN
    RAISE EXCEPTION 'unknown run trigger' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_task
    FROM control_plane.scheduled_tasks
    WHERE tenant_id = v_tenant_id AND task_id = p_task_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_trigger = 'manual' THEN
    UPDATE control_plane.scheduled_task_runs SET
      status = 'running',
      started_at = clock_timestamp()
    WHERE tenant_id = v_tenant_id AND run_id = p_run_id AND task_id = p_task_id AND status = 'queued'
    RETURNING * INTO v_run;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    UPDATE control_plane.scheduled_tasks SET last_run_at = clock_timestamp()
    WHERE tenant_id = v_tenant_id AND task_id = p_task_id;
    RETURN control_plane.scheduled_run_json(v_run);
  END IF;

  IF p_run_id IS NULL OR p_run_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$' THEN
    RAISE EXCEPTION 'run id must be a ULID' USING ERRCODE = '22023';
  END IF;
  IF NOT v_task.enabled
    OR v_task.next_run_at IS NULL
    OR v_task.next_run_at > clock_timestamp()
    OR p_expected_next_run_at IS NULL
    OR v_task.next_run_at <> p_expected_next_run_at
  THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.scheduled_task_runs AS open
    WHERE open.tenant_id = v_tenant_id AND open.task_id = p_task_id AND open.status IN ('queued', 'running')
  ) THEN
    RETURN NULL;
  END IF;
  UPDATE control_plane.scheduled_tasks SET
    next_run_at = p_next_run_at,
    last_run_at = clock_timestamp()
  WHERE tenant_id = v_tenant_id AND task_id = p_task_id;
  INSERT INTO control_plane.scheduled_task_runs (
    tenant_id, run_id, task_id, trigger, status, requested_at, started_at, scheduled_for
  ) VALUES (
    v_tenant_id, p_run_id, p_task_id, 'schedule', 'running', clock_timestamp(), clock_timestamp(), v_task.next_run_at
  )
  RETURNING * INTO v_run;
  RETURN control_plane.scheduled_run_json(v_run);
END;
$$;

-- Record a run's outcome. Owner session (the bridge).
CREATE OR REPLACE FUNCTION public.albert_scheduled_run_finish(
  p_run_id text,
  p_status text,
  p_conversation_id text,
  p_turn_id text,
  p_answer_state text,
  p_summary text,
  p_error text,
  p_bubbles integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_run control_plane.scheduled_task_runs%ROWTYPE;
BEGIN
  IF p_status NOT IN ('sent', 'failed', 'missed') THEN
    RAISE EXCEPTION 'a run finishes as sent, failed or missed' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.scheduled_task_runs SET
    status = p_status,
    finished_at = clock_timestamp(),
    conversation_id = coalesce(p_conversation_id, conversation_id),
    turn_id = coalesce(p_turn_id, turn_id),
    answer_state = left(p_answer_state, 40),
    summary = left(p_summary, 400),
    error = left(p_error, 400),
    bubbles = p_bubbles
  WHERE tenant_id = v_tenant_id AND run_id = p_run_id AND status = 'running'
  RETURNING * INTO v_run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no running run to finish' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.scheduled_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION control_plane.scheduled_run_json(control_plane.scheduled_task_runs) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.scheduled_task_json(control_plane.scheduled_tasks) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.scheduled_task_detail_json(control_plane.scheduled_tasks) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.scheduled_runs_sweep(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_scheduled_workspace() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_scheduled_task_save(text, text, text, text, text, jsonb, text, text, boolean, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_scheduled_task_delete(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_scheduled_run_request(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_scheduled_work() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_scheduled_run_claim(text, text, text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_scheduled_run_finish(text, text, text, text, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_scheduled_workspace() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_scheduled_task_save(text, text, text, text, text, jsonb, text, text, boolean, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_scheduled_task_delete(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_scheduled_run_request(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_scheduled_work() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_scheduled_run_claim(text, text, text, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_scheduled_run_finish(text, text, text, text, text, text, text, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
