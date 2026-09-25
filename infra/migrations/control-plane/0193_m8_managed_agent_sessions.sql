-- ADR 0140: server-owned managed sessions with owner, turn and revision fences.
BEGIN;

CREATE TABLE control_plane.managed_agent_server_keys (
  key_id text PRIMARY KEY CHECK (length(key_id) BETWEEN 3 AND 100),
  key_sha256 text NOT NULL UNIQUE CHECK (key_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);
REVOKE ALL ON control_plane.managed_agent_server_keys FROM PUBLIC, anon, authenticated;

CREATE TABLE control_plane.managed_agent_sessions (
  tenant_id text NOT NULL,
  conversation_id text NOT NULL,
  actor_id uuid NOT NULL,
  active_turn_id text NOT NULL,
  state jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(state) = 'object' AND octet_length(state::text) <= 262144),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES control_plane.conversations(tenant_id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, active_turn_id)
    REFERENCES control_plane.conversation_turns(tenant_id, turn_id) ON DELETE CASCADE
);
ALTER TABLE control_plane.managed_agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.managed_agent_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_agent_actor_scope ON control_plane.managed_agent_sessions
  USING (tenant_id = control_plane.require_current_tenant_id() AND actor_id = extensions.albert_auth_uid())
  WITH CHECK (tenant_id = control_plane.require_current_tenant_id() AND actor_id = extensions.albert_auth_uid());
REVOKE ALL ON control_plane.managed_agent_sessions FROM PUBLIC, anon, authenticated;

CREATE FUNCTION control_plane.require_managed_agent_server(p_server_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_server_key IS NULL OR length(p_server_key) NOT BETWEEN 32 AND 200
     OR NOT EXISTS (
       SELECT 1 FROM control_plane.managed_agent_server_keys
        WHERE revoked_at IS NULL
          AND key_sha256 = encode(extensions.digest(p_server_key, 'sha256'), 'hex')
     ) THEN
    RAISE EXCEPTION 'managed agent server capability required' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION control_plane.require_managed_agent_server(text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.albert_claim_managed_agent_session(
  p_conversation_id text, p_turn_id text, p_server_key text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  selected_tenant text;
  actor uuid;
  result jsonb;
BEGIN
  PERFORM control_plane.require_managed_agent_server(p_server_key);
  actor := extensions.albert_auth_uid();
  selected_tenant := control_plane.require_current_tenant_id();
  IF actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM control_plane.conversation_turns AS turn
    JOIN control_plane.conversations AS conversation
      ON conversation.tenant_id = turn.tenant_id AND conversation.conversation_id = turn.conversation_id
    WHERE turn.tenant_id = selected_tenant AND turn.turn_id = p_turn_id
      AND turn.conversation_id = p_conversation_id AND turn.created_by = actor
      AND conversation.created_by = actor AND conversation.status = 'active'
      AND turn.status = 'running' AND turn.hidden_at IS NULL
      AND turn.runtime_profile->>'runtime' = 'openai-agents-api'
  ) THEN
    RAISE EXCEPTION 'an owned running managed-agent turn is required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('managed-agent:' || selected_tenant || ':' || p_conversation_id, 0));
  IF EXISTS (
    SELECT 1 FROM control_plane.managed_agent_sessions AS session
    JOIN control_plane.conversation_turns AS turn
      ON turn.tenant_id = session.tenant_id AND turn.turn_id = session.active_turn_id
    WHERE session.tenant_id = selected_tenant AND session.conversation_id = p_conversation_id
      AND session.active_turn_id <> p_turn_id AND turn.status = 'running' AND turn.hidden_at IS NULL
  ) THEN
    RAISE EXCEPTION 'another managed-agent turn is running' USING ERRCODE = '55000';
  END IF;
  INSERT INTO control_plane.managed_agent_sessions (tenant_id, conversation_id, actor_id, active_turn_id)
  VALUES (selected_tenant, p_conversation_id, actor, p_turn_id)
  ON CONFLICT (tenant_id, conversation_id) DO UPDATE
    SET active_turn_id = EXCLUDED.active_turn_id
    WHERE managed_agent_sessions.actor_id = actor;
  SELECT jsonb_build_object('state', state, 'revision', revision, 'updatedAt', updated_at)
    INTO result FROM control_plane.managed_agent_sessions
   WHERE tenant_id = selected_tenant AND conversation_id = p_conversation_id AND actor_id = actor;
  IF result IS NULL THEN RAISE EXCEPTION 'conversation was not found' USING ERRCODE = 'P0002'; END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION public.albert_save_managed_agent_session(
  p_conversation_id text, p_turn_id text, p_revision bigint, p_state jsonb, p_server_key text
)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE selected_tenant text; actor uuid; next_revision bigint;
BEGIN
  PERFORM control_plane.require_managed_agent_server(p_server_key);
  actor := extensions.albert_auth_uid();
  selected_tenant := control_plane.require_current_tenant_id();
  IF p_state IS NULL OR jsonb_typeof(p_state) <> 'object' OR octet_length(p_state::text) > 262144 THEN
    RAISE EXCEPTION 'invalid managed-agent state' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.managed_agent_sessions AS session
     SET state = p_state, revision = session.revision + 1, updated_at = clock_timestamp()
   WHERE session.tenant_id = selected_tenant AND session.conversation_id = p_conversation_id
     AND session.actor_id = actor AND session.active_turn_id = p_turn_id AND session.revision = p_revision
     AND EXISTS (
       SELECT 1 FROM control_plane.conversation_turns AS turn
        WHERE turn.tenant_id = selected_tenant AND turn.turn_id = p_turn_id
          AND turn.conversation_id = p_conversation_id AND turn.created_by = actor
          AND turn.status = 'running' AND turn.hidden_at IS NULL
     )
   RETURNING session.revision INTO next_revision;
  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'managed-agent state revision or turn ownership changed' USING ERRCODE = '40001';
  END IF;
  RETURN next_revision;
END;
$$;

CREATE FUNCTION public.albert_managed_agent_results(
  p_conversation_id text, p_result_ids text[], p_server_key text
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE selected_tenant text; actor uuid; result jsonb;
BEGIN
  PERFORM control_plane.require_managed_agent_server(p_server_key);
  actor := extensions.albert_auth_uid();
  selected_tenant := control_plane.require_current_tenant_id();
  IF p_result_ids IS NULL OR cardinality(p_result_ids) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'one to eight result references are required' USING ERRCODE = '22023';
  END IF;
  IF actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM control_plane.conversations WHERE tenant_id = selected_tenant
      AND conversation_id = p_conversation_id AND created_by = actor
  ) THEN RAISE EXCEPTION 'conversation was not found' USING ERRCODE = 'P0002'; END IF;
  WITH original_tables AS (
    SELECT DISTINCT ON (event.event->>'resultId') event.event, event.turn_id, turn.turn_number
      FROM control_plane.conversation_turn_events AS event
      JOIN control_plane.conversation_turns AS turn
        ON turn.tenant_id = event.tenant_id AND turn.turn_id = event.turn_id
     WHERE event.tenant_id = selected_tenant AND event.conversation_id = p_conversation_id
       AND turn.created_by = actor AND turn.hidden_at IS NULL
       AND event.event->>'type' = 'table' AND event.event->>'resultId' = ANY(p_result_ids)
     ORDER BY event.event->>'resultId', turn.turn_number, event.sequence_number
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'table', original.event,
    'query', (SELECT query.event FROM control_plane.conversation_turn_events AS query
       WHERE query.tenant_id = selected_tenant AND query.conversation_id = p_conversation_id
         AND query.turn_id = original.turn_id AND query.event->>'type' = 'query'
         AND query.event->>'resultId' = original.event->>'resultId'
       ORDER BY query.sequence_number LIMIT 1)
  )), '[]'::jsonb) INTO result FROM original_tables AS original;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_claim_managed_agent_session(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.albert_save_managed_agent_session(text, text, bigint, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.albert_managed_agent_results(text, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.albert_claim_managed_agent_session(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_save_managed_agent_session(text, text, bigint, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_managed_agent_results(text, text[], text) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
