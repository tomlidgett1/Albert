-- 0175: Swarm runs survive the browser that started them (ADR 0120 update).
--
-- The fleet is browser-orchestrated (ADR 0111/0120: turn leases stay on
-- `authenticated`), so a closed tab, a reload, or a slept laptop kills the
-- orchestrator mid-run and nothing settles control_plane.swarm_runs /
-- swarm_agents: the run stays 'running' forever and every later dash visit
-- re-opens a frozen panel. Four repairs, each keyed to state that is already
-- persisted rather than to anything the browser asserts:
--
-- 1. albert_swarm_reconcile_run settles a stranded run. It is gated on the
--    parent turn's lease: a live orchestrator renews that lease from
--    /api/swarm/heartbeat and the agent lifecycle routes, so an expired lease
--    is proof the browser is gone. Still-open agents fail with a disconnect
--    note and the run settles through swarm_settle_run, keeping completed
--    findings salvageable by synthesis.
-- 2. albert_swarm_agent_completed now also accepts a 'failed' agent row.
--    A child turn persists its answer on its own conversation before the
--    browser relays it, so a finding whose record POST never landed (or that
--    reconciliation failed first) is recoverable at synthesis time from the
--    child's own transcript. 'stopped' stays terminal — the owner chose it.
-- 3. albert_swarm_complete_parent_turn closes a synthesised parent turn as
--    completed instead of failed. Completion is derived entirely from the
--    persisted synthesis row — not from browser-supplied values — which is
--    the lineage the retired browser-callable complete_albert_turn (0015)
--    could not establish.
-- 4. albert_conversation_history / albert_model_context show a completed
--    turn's answer events either when an answer artifact exists or when the
--    turn carries the swarm completion receipt in result_digest, since a
--    swarm parent turn has no answer artifact of its own.
-- 5. albert_list_conversations excludes swarm child conversations at the
--    source. The sidebar previously subtracted a 400-row capped id list
--    client-side, so old children leaked back once a tenant accumulated
--    more than 400 of them.

BEGIN;

CREATE OR REPLACE FUNCTION public.albert_swarm_reconcile_run(p_run_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_actor uuid := extensions.albert_auth_uid();
  v_run control_plane.swarm_runs%ROWTYPE;
  v_turn_status text;
  v_turn_lease timestamptz;
  v_failed_agents integer := 0;
  v_completed integer := 0;
  v_new_status text;
BEGIN
  IF p_run_id IS NULL OR NOT control_plane.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'swarm run id must be a ULID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run
  FROM control_plane.swarm_runs
  WHERE tenant_id = v_tenant_id AND run_id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swarm run not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.status NOT IN ('running', 'synthesising') THEN
    RETURN jsonb_build_object(
      'reconciled', false,
      'run', control_plane.swarm_run_json(v_tenant_id, p_run_id)
    );
  END IF;

  SELECT turn.status, turn.lease_expires_at
    INTO v_turn_status, v_turn_lease
  FROM control_plane.conversation_turns AS turn
  WHERE turn.tenant_id = v_tenant_id
    AND turn.turn_id = v_run.parent_turn_id
    AND turn.conversation_id = v_run.parent_conversation_id;
  -- A live orchestrator renews this lease; while it holds, the run is not
  -- stranded and reconciliation must not touch it.
  IF v_turn_status = 'running'
     AND v_turn_lease IS NOT NULL
     AND v_turn_lease > clock_timestamp() THEN
    RETURN jsonb_build_object(
      'reconciled', false,
      'run', control_plane.swarm_run_json(v_tenant_id, p_run_id)
    );
  END IF;

  UPDATE control_plane.swarm_agents
  SET status = 'failed',
      failure_note = 'The browser running this swarm disconnected before the specialist finished.',
      completed_at = coalesce(completed_at, clock_timestamp())
  WHERE tenant_id = v_tenant_id
    AND run_id = p_run_id
    AND status IN ('pending', 'running');
  GET DIAGNOSTICS v_failed_agents = ROW_COUNT;

  PERFORM control_plane.swarm_settle_run(v_tenant_id, p_run_id);

  SELECT count(*) FILTER (WHERE agent.status = 'completed')
    INTO v_completed
  FROM control_plane.swarm_agents AS agent
  WHERE agent.tenant_id = v_tenant_id AND agent.run_id = p_run_id;

  -- Nothing completed, so no synthesis will ever close the parent turn:
  -- release it here the way fail_albert_turn would have.
  IF v_completed = 0 AND v_turn_status = 'running' THEN
    UPDATE control_plane.conversation_turns
    SET status = 'failed',
        result_digest = 'albert_swarm_browser_disconnected',
        completed_at = now()
    WHERE tenant_id = v_tenant_id
      AND turn_id = v_run.parent_turn_id
      AND conversation_id = v_run.parent_conversation_id
      AND status = 'running';
    IF FOUND THEN
      INSERT INTO control_plane.audit_log (
        tenant_id, audit_id, actor_user_id, actor_type, action,
        resource_type, resource_id, audit_metadata
      ) VALUES (
        v_tenant_id, control_plane.generate_ulid(), v_actor, 'user',
        'conversation.turn_failed', 'conversation_turn', v_run.parent_turn_id,
        jsonb_build_object('failure_code', 'albert_swarm_browser_disconnected')
      );
    END IF;
  END IF;

  SELECT run.status INTO v_new_status
  FROM control_plane.swarm_runs AS run
  WHERE run.tenant_id = v_tenant_id AND run.run_id = p_run_id;

  RETURN jsonb_build_object(
    'reconciled', v_failed_agents > 0 OR v_new_status IS DISTINCT FROM v_run.status,
    'run', control_plane.swarm_run_json(v_tenant_id, p_run_id)
  );
END;
$$;

-- Recovery: 'failed' joins the acceptable prior states. A child conversation
-- persists its answer before the browser relays it to /api/swarm/agent, so a
-- lost record POST (or a reconciliation that ran first) must not erase a
-- finished analysis. 'stopped' stays terminal because the owner chose it.
CREATE OR REPLACE FUNCTION public.albert_swarm_agent_completed(
  p_run_id text,
  p_agent_key text,
  p_answer_state text,
  p_headline text,
  p_summary text,
  p_key_numbers jsonb,
  p_questions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_row control_plane.swarm_agents%ROWTYPE;
BEGIN
  UPDATE control_plane.swarm_agents
  SET status = 'completed',
      answer_state = p_answer_state,
      headline = left(p_headline, 300),
      summary = left(p_summary, 8000),
      key_numbers = coalesce(p_key_numbers, '[]'::jsonb),
      questions = coalesce(p_questions, '[]'::jsonb),
      failure_note = NULL,
      completed_at = clock_timestamp()
  WHERE tenant_id = v_tenant_id
    AND run_id = p_run_id
    AND agent_key = p_agent_key
    AND status IN ('pending', 'running', 'failed')
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swarm agent not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM control_plane.swarm_settle_run(v_tenant_id, p_run_id);
  RETURN control_plane.swarm_agent_row_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_swarm_complete_parent_turn(p_run_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text := control_plane.require_current_tenant_id();
  v_actor uuid := extensions.albert_auth_uid();
  v_run control_plane.swarm_runs%ROWTYPE;
  v_state text;
  v_turn_status text;
BEGIN
  IF p_run_id IS NULL OR NOT control_plane.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'swarm run id must be a ULID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run
  FROM control_plane.swarm_runs
  WHERE tenant_id = v_tenant_id AND run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'swarm run not found' USING ERRCODE = 'P0002';
  END IF;
  -- The persisted synthesis is the completion evidence; without it the turn
  -- keeps the failure-code release path.
  IF v_run.status <> 'completed' OR v_run.synthesis IS NULL THEN
    RAISE EXCEPTION 'swarm synthesis must be recorded before the parent turn completes'
      USING ERRCODE = '55000';
  END IF;
  v_state := lower(coalesce(v_run.synthesis ->> 'answerState', ''));
  IF v_state = 'no data' THEN
    v_state := 'no_data';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.answer_state_lookup WHERE state = v_state
  ) THEN
    RAISE EXCEPTION 'swarm synthesis answer state is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT turn.status INTO v_turn_status
  FROM control_plane.conversation_turns AS turn
  WHERE turn.tenant_id = v_tenant_id
    AND turn.turn_id = v_run.parent_turn_id
    AND turn.conversation_id = v_run.parent_conversation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation turn was not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_turn_status = 'running' THEN
    UPDATE control_plane.conversation_turns
    SET status = 'completed',
        answer_state = v_state,
        provider_response_id = coalesce(provider_response_id, 'albert-swarm:' || v_run.run_id),
        usage = coalesce(usage, '{}'::jsonb),
        result_digest = 'albert_swarm_answered',
        completed_at = now()
    WHERE tenant_id = v_tenant_id
      AND turn_id = v_run.parent_turn_id
      AND conversation_id = v_run.parent_conversation_id;
    INSERT INTO control_plane.audit_log (
      tenant_id, audit_id, actor_user_id, actor_type, action,
      resource_type, resource_id, audit_metadata
    ) VALUES (
      v_tenant_id, control_plane.generate_ulid(), v_actor, 'user',
      'conversation.turn_completed', 'conversation_turn', v_run.parent_turn_id,
      jsonb_build_object('answer_state', v_state, 'swarm_run_id', v_run.run_id)
    );
    v_turn_status := 'completed';
  END IF;

  RETURN jsonb_build_object(
    'turnStatus', v_turn_status,
    'completed', v_turn_status = 'completed'
  );
END;
$$;

-- 0157's albert_conversation_history, with one change: a completed turn's
-- answer events are also visible when the turn carries the swarm completion
-- receipt, because a swarm parent turn completes from its persisted synthesis
-- and never owns an answer artifact.
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
  actor uuid := extensions.albert_auth_uid();
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
    SELECT turn.turn_id, turn.turn_number, event.event,
           row_number() OVER (ORDER BY turn.turn_number, event.sequence_number)::integer AS conversation_sequence
      FROM control_plane.conversation_turns AS turn
      JOIN control_plane.conversation_turn_events AS event
        ON event.tenant_id = turn.tenant_id AND event.turn_id = turn.turn_id
     WHERE turn.tenant_id = selected_tenant
       AND turn.conversation_id = p_conversation_id
       AND turn.created_by = actor
       AND turn.hidden_at IS NULL
       AND (
         event.event->>'type' NOT IN ('answer', 'clarification')
         OR (
           turn.status = 'completed'
           AND (
             EXISTS (
               SELECT 1 FROM control_plane.answer_artifacts AS artifact
                WHERE artifact.tenant_id = turn.tenant_id
                  AND artifact.conversation_id = turn.conversation_id
                  AND artifact.turn_id = turn.turn_id
             )
             OR turn.result_digest = 'albert_swarm_answered'
           )
           OR turn.status = 'failed'
         )
       )
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
          'model', turn.runtime_profile->'model',
          'reasoningEffort', turn.runtime_profile->'reasoningEffort',
          'fastMode', turn.runtime_profile->'fastMode',
          'runtime', turn.runtime_profile->'runtime',
          'analyticalRuntime', turn.runtime_profile->'analyticalRuntime',
          'provider', turn.runtime_profile->'provider',
          'specialistAgentId', coalesce(
            turn.runtime_profile->'specialistAgentId',
            '"general"'::jsonb
          ),
          'specialistAgentVersion', turn.runtime_profile->'specialistAgentVersion',
          'specialistAgentDigest', turn.runtime_profile->'specialistAgentDigest'
        ),
        'created_at', turn.created_at,
        'completed_at', turn.completed_at,
        'events', coalesce((
          SELECT jsonb_agg(event.event || jsonb_build_object(
            'conversationSequence', event.conversation_sequence
          ) ORDER BY event.conversation_sequence)
            FROM ordered_events AS event
           WHERE event.turn_id = turn.turn_id
             AND event.conversation_sequence > p_after_sequence
        ), '[]'::jsonb)
      ) ORDER BY turn.turn_number)
        FROM control_plane.conversation_turns AS turn
       WHERE turn.tenant_id = selected_tenant
         AND turn.conversation_id = p_conversation_id
         AND turn.created_by = actor
         AND turn.hidden_at IS NULL
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

-- 0152's albert_model_context, with the same completed-turn visibility change.
CREATE OR REPLACE FUNCTION public.albert_model_context(
  p_conversation_id text,
  p_turn_limit integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  result jsonb;
BEGIN
  IF p_turn_limit NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'model context turn limit must be between 1 and 24' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.conversations AS conversation
     WHERE conversation.tenant_id = selected_tenant
       AND conversation.conversation_id = p_conversation_id
       AND conversation.created_by = actor
  ) THEN
    RAISE EXCEPTION 'conversation was not found' USING ERRCODE = 'P0002';
  END IF;

  WITH recent AS (
    SELECT turn.turn_number, turn.user_message, turn.status,
           artifact.answer_state AS artifact_answer_state,
           artifact.answer_text AS artifact_answer_text,
           (
             SELECT execution.event_payload->'resolvedSubject'
               FROM control_plane.answer_execution_events AS execution
              WHERE execution.tenant_id = artifact.tenant_id
                AND execution.answer_artifact_id = artifact.answer_artifact_id
                AND execution.event_type = 'answer'
              ORDER BY execution.sequence_number DESC
              LIMIT 1
           ) AS artifact_resolved_subject,
           (
             SELECT event.event
               FROM control_plane.conversation_turn_events AS event
              WHERE event.tenant_id = turn.tenant_id
                AND event.turn_id = turn.turn_id
                AND event.event->>'type' IN ('answer', 'clarification')
              ORDER BY event.sequence_number DESC
              LIMIT 1
           ) AS terminal_event
      FROM control_plane.conversation_turns AS turn
      LEFT JOIN control_plane.answer_artifacts AS artifact
        ON artifact.tenant_id = turn.tenant_id
       AND artifact.conversation_id = turn.conversation_id
       AND artifact.turn_id = turn.turn_id
     WHERE turn.tenant_id = selected_tenant
       AND turn.conversation_id = p_conversation_id
       AND turn.created_by = actor
       AND turn.hidden_at IS NULL
       AND (
         turn.status = 'completed'
         AND (
           artifact.answer_artifact_id IS NOT NULL
           OR turn.result_digest = 'albert_swarm_answered'
         )
         -- A failed turn contributes the owner's message; its terminal event
         -- (when one exists) is still projected, otherwise assistant_event
         -- carries no text and the runtime renders it as an unanswered turn.
         OR turn.status = 'failed'
       )
     ORDER BY turn.turn_number DESC
     LIMIT p_turn_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'turn_number', recent.turn_number,
    'user_message', recent.user_message,
    'status', recent.status,
    'assistant_event', CASE
      WHEN coalesce(recent.terminal_event->>'type', '') = 'clarification'
        OR coalesce(recent.artifact_answer_state, '') = 'clarification'
      THEN jsonb_build_object(
        'type', 'clarification',
        'question', coalesce(recent.terminal_event->>'question', recent.artifact_answer_text)
      )
      ELSE jsonb_build_object(
        'type', 'answer',
        'text', coalesce(recent.terminal_event->>'text', recent.artifact_answer_text)
      )
        || CASE WHEN recent.terminal_event IS NOT NULL
          AND jsonb_typeof(recent.terminal_event->'provenance') = 'object'
          THEN jsonb_build_object('provenance', recent.terminal_event->'provenance')
          ELSE '{}'::jsonb
        END
        || CASE WHEN jsonb_typeof(
          coalesce(recent.terminal_event->'resolvedSubject', recent.artifact_resolved_subject)
        ) = 'object'
          THEN jsonb_build_object(
            'resolvedSubject',
            coalesce(recent.terminal_event->'resolvedSubject', recent.artifact_resolved_subject)
          )
          ELSE '{}'::jsonb
        END
    END
  ) ORDER BY recent.turn_number), '[]'::jsonb)
    INTO result
    FROM recent;
  RETURN result;
END;
$$;

-- The sidebar exclusion anti-joins on child conversation ids, which 0168
-- never indexed.
CREATE INDEX IF NOT EXISTS swarm_agents_by_conversation
  ON control_plane.swarm_agents (tenant_id, conversation_id)
  WHERE conversation_id IS NOT NULL;

-- 0157's albert_list_conversations, with one change: conversations owned by a
-- swarm agent never appear. They are working threads of the fleet (ADR 0120
-- keeps them out of the sidebar); the previous client-side subtraction leaked
-- old children back once the capped hidden-id list overflowed.
CREATE OR REPLACE FUNCTION public.albert_list_conversations(p_limit integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
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
          'fastMode', turn.runtime_profile -> 'fastMode',
          'runtime', turn.runtime_profile -> 'runtime',
          'analyticalRuntime', turn.runtime_profile -> 'analyticalRuntime',
          'provider', turn.runtime_profile -> 'provider',
          'specialistAgentId', coalesce(
            turn.runtime_profile -> 'specialistAgentId',
            '"general"'::jsonb
          ),
          'specialistAgentVersion', turn.runtime_profile -> 'specialistAgentVersion',
          'specialistAgentDigest', turn.runtime_profile -> 'specialistAgentDigest'
        ),
        'created_at', turn.created_at,
        'completed_at', turn.completed_at
      )
      FROM control_plane.conversation_turns AS turn
      WHERE turn.tenant_id = selected_tenant
        AND turn.conversation_id = conversation.conversation_id
        AND turn.created_by = actor
        AND turn.hidden_at IS NULL
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
      AND NOT EXISTS (
        SELECT 1
        FROM control_plane.swarm_agents AS agent
        WHERE agent.tenant_id = selected_tenant
          AND agent.conversation_id = candidate.conversation_id
      )
    ORDER BY candidate.updated_at DESC
    LIMIT p_limit
  ) AS conversation;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_swarm_reconcile_run(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_swarm_agent_completed(text, text, text, text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_swarm_complete_parent_turn(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.albert_swarm_reconcile_run(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_swarm_agent_completed(text, text, text, text, text, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_swarm_complete_parent_turn(text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
