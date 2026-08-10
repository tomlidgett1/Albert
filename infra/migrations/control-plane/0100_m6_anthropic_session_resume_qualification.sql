-- The claim function returns a column named session_id. In PL/pgSQL that
-- output variable makes unqualified session_id references inside UPDATE
-- statements ambiguous once an existing session is resumed. Qualify the
-- target relation so both new-session and resume paths are deterministic.

BEGIN;

CREATE OR REPLACE FUNCTION control_plane.claim_anthropic_conversation_session(
  p_tenant_id text,
  p_actor_user_id uuid,
  p_conversation_id text,
  p_turn_id text,
  p_candidate_session_id uuid,
  p_runtime text,
  p_model text,
  p_sdk_version text,
  p_prompt_digest text,
  p_toolset_digest text
)
RETURNS TABLE(session_id uuid,created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  active control_plane.anthropic_conversation_sessions%ROWTYPE;
BEGIN
  IF current_setting('albert.tenant_id',true) IS DISTINCT FROM p_tenant_id
     OR p_actor_user_id IS NULL
     OR NOT control_plane.is_ulid(p_conversation_id)
     OR NOT control_plane.is_ulid(p_turn_id)
     OR p_candidate_session_id IS NULL
     OR p_runtime<>'anthropic-agent-sdk'
     OR p_model IS NULL OR length(p_model) NOT BETWEEN 8 AND 512
     OR p_sdk_version!~'^[0-9]+\.[0-9]+\.[0-9]+$'
     OR p_prompt_digest!~'^[a-f0-9]{64}$'
     OR p_toolset_digest!~'^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Anthropic session request is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM 1
    FROM control_plane.conversation_turns AS turn
    JOIN control_plane.conversations AS conversation
      ON conversation.tenant_id=turn.tenant_id
     AND conversation.conversation_id=turn.conversation_id
   WHERE turn.tenant_id=p_tenant_id
     AND turn.conversation_id=p_conversation_id
     AND turn.turn_id=p_turn_id
     AND turn.created_by=p_actor_user_id
     AND conversation.created_by=p_actor_user_id
     AND turn.status='running'
     AND turn.runtime_profile->>'runtime'='anthropic-agent-sdk'
   FOR UPDATE OF turn;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'running Anthropic turn was not found' USING ERRCODE='P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('anthropic-session:'||p_tenant_id||':'||p_conversation_id,0));
  SELECT candidate.* INTO active
    FROM control_plane.anthropic_conversation_sessions AS candidate
   WHERE candidate.tenant_id=p_tenant_id
     AND candidate.conversation_id=p_conversation_id
     AND candidate.superseded_at IS NULL
   FOR UPDATE;
  IF FOUND AND active.expires_at>now()
     AND active.runtime=p_runtime AND active.model=p_model
     AND active.sdk_version=p_sdk_version
     AND active.prompt_digest=p_prompt_digest
     AND active.toolset_digest=p_toolset_digest THEN
    UPDATE control_plane.anthropic_conversation_sessions AS existing_session
       SET updated_at=now(),
           expires_at=greatest(existing_session.expires_at,now()+interval '30 days')
     WHERE existing_session.tenant_id=p_tenant_id
       AND existing_session.session_id=active.session_id;
    session_id:=active.session_id;
    created:=false;
    RETURN NEXT;
    RETURN;
  END IF;
  IF FOUND THEN
    UPDATE control_plane.anthropic_conversation_sessions AS superseded_session
       SET superseded_at=now(),updated_at=now()
     WHERE superseded_session.tenant_id=p_tenant_id
       AND superseded_session.session_id=active.session_id;
  END IF;
  INSERT INTO control_plane.anthropic_conversation_sessions(
    tenant_id,session_id,conversation_id,runtime,model,sdk_version,
    prompt_digest,toolset_digest,created_by
  ) VALUES (
    p_tenant_id,p_candidate_session_id,p_conversation_id,p_runtime,p_model,p_sdk_version,
    p_prompt_digest,p_toolset_digest,p_actor_user_id
  );
  session_id:=p_candidate_session_id;
  created:=true;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.claim_anthropic_conversation_session(text,uuid,text,text,uuid,text,text,text,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION control_plane.claim_anthropic_conversation_session(text,uuid,text,text,uuid,text,text,text,text,text)
  TO albert_anthropic_control;

COMMIT;
