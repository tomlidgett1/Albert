BEGIN;

-- A conversation is method-locked at the database boundary. Legacy profiles
-- without an explicit runtime are OpenAI conversations.
CREATE OR REPLACE FUNCTION control_plane.enforce_conversation_runtime_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  existing_runtime text;
  requested_runtime text := coalesce(NULLIF(NEW.runtime_profile->>'runtime',''),'openai-agents-sdk');
BEGIN
  SELECT coalesce(NULLIF(turn.runtime_profile->>'runtime',''),'openai-agents-sdk')
    INTO existing_runtime
    FROM control_plane.conversation_turns AS turn
   WHERE turn.tenant_id=NEW.tenant_id
     AND turn.conversation_id=NEW.conversation_id
   ORDER BY turn.turn_number
   LIMIT 1;
  IF existing_runtime IS NOT NULL AND existing_runtime IS DISTINCT FROM requested_runtime THEN
    RAISE EXCEPTION 'conversation analytics runtime is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversation_turns_runtime_lock ON control_plane.conversation_turns;
CREATE TRIGGER conversation_turns_runtime_lock
  BEFORE INSERT ON control_plane.conversation_turns
  FOR EACH ROW EXECUTE FUNCTION control_plane.enforce_conversation_runtime_lock();

-- Keep the public conversation payload provider-neutral while preserving the
-- explicit method lock. The existing functions intentionally project only a
-- safe runtime-profile subset; add the runtime discriminator to that subset
-- and treat every legacy profile as OpenAI.
DO $$
DECLARE
  definition text;
  old_history constant text := '''fastMode'', turn.runtime_profile->''fastMode''';
  new_history constant text := '''fastMode'', turn.runtime_profile->''fastMode'',
          ''runtime'', coalesce(NULLIF(turn.runtime_profile->>''runtime'',''''),''openai-agents-sdk'')';
  old_list constant text := '''fastMode'', turn.runtime_profile -> ''fastMode''';
  new_list constant text := '''fastMode'', turn.runtime_profile -> ''fastMode'',
          ''runtime'', coalesce(NULLIF(turn.runtime_profile->>''runtime'',''''),''openai-agents-sdk'')';
BEGIN
  definition := pg_get_functiondef(
    'public.albert_conversation_history(text,integer)'::regprocedure
  );
  IF position('''runtime'', coalesce(NULLIF(turn.runtime_profile->>''runtime''' IN definition)=0 THEN
    IF position(old_history IN definition)=0 THEN
      RAISE EXCEPTION 'albert_conversation_history runtime projection drifted; refusing an unsafe migration';
    END IF;
    EXECUTE replace(definition,old_history,new_history);
  END IF;

  definition := pg_get_functiondef(
    'public.albert_list_conversations(integer)'::regprocedure
  );
  IF position('''runtime'', coalesce(NULLIF(turn.runtime_profile->>''runtime''' IN definition)=0 THEN
    IF position(old_list IN definition)=0 THEN
      RAISE EXCEPTION 'albert_list_conversations runtime projection drifted; refusing an unsafe migration';
    END IF;
    EXECUTE replace(definition,old_list,new_list);
  END IF;
END;
$$;

-- Provider-neutral usage storage. The existing v1 API remains valid; v2 adds
-- Anthropic inputs while retaining the same immutable artifact machinery.
ALTER TABLE control_plane.model_usage_ledger
  DROP CONSTRAINT IF EXISTS model_usage_ledger_model_check;
ALTER TABLE control_plane.model_usage_ledger
  ADD CONSTRAINT model_usage_ledger_model_check
  CHECK (model IN (
    'gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna',
    'claude-opus-5','claude-sonnet-5'
  ));

DO $$
DECLARE
  definition text;
  old_guard constant text := 'p_metering->>''model'' NOT IN (''gpt-5.6-sol'',''gpt-5.6-terra'',''gpt-5.6-luna'')';
  new_guard constant text := 'p_metering->>''model'' NOT IN (''gpt-5.6-sol'',''gpt-5.6-terra'',''gpt-5.6-luna'',''claude-opus-5'',''claude-sonnet-5'')';
BEGIN
  definition := pg_get_functiondef(
    'control_plane.finalize_answer_artifact(text,uuid,text,text,text,jsonb,text,text,jsonb,jsonb)'::regprocedure
  );
  IF position(new_guard IN definition)>0 THEN
    NULL;
  ELSIF position(old_guard IN definition)>0 THEN
    EXECUTE replace(definition,old_guard,new_guard);
  ELSE
    RAISE EXCEPTION 'finalize_answer_artifact model guard drifted; refusing an unsafe migration';
  END IF;

  definition := pg_get_functiondef(
    'control_plane.record_model_usage_checkpoint(text,uuid,text,text,text,jsonb,jsonb,text)'::regprocedure
  );
  IF position(new_guard IN definition)>0 THEN
    NULL;
  ELSIF position(old_guard IN definition)>0 THEN
    EXECUTE replace(definition,old_guard,new_guard);
  ELSE
    RAISE EXCEPTION 'record_model_usage_checkpoint model guard drifted; refusing an unsafe migration';
  END IF;
END;
$$;

CREATE TABLE control_plane.anthropic_conversation_sessions (
  tenant_id text NOT NULL,
  session_id uuid NOT NULL,
  conversation_id text NOT NULL,
  runtime text NOT NULL CHECK (runtime='anthropic-agent-sdk'),
  model text NOT NULL CHECK (model IN ('claude-opus-5','claude-sonnet-5') OR length(model) BETWEEN 20 AND 512),
  sdk_version text NOT NULL CHECK (sdk_version~'^[0-9]+\.[0-9]+\.[0-9]+$'),
  prompt_digest text NOT NULL CHECK (prompt_digest~'^[a-f0-9]{64}$'),
  toolset_digest text NOT NULL CHECK (toolset_digest~'^[a-f0-9]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
  superseded_at timestamptz,
  PRIMARY KEY (tenant_id,session_id),
  FOREIGN KEY (tenant_id,conversation_id)
    REFERENCES control_plane.conversations(tenant_id,conversation_id) ON DELETE CASCADE,
  CHECK (expires_at>created_at),
  CHECK (superseded_at IS NULL OR superseded_at>=created_at)
);

CREATE UNIQUE INDEX anthropic_conversation_sessions_one_active
  ON control_plane.anthropic_conversation_sessions(tenant_id,conversation_id)
  WHERE superseded_at IS NULL;

CREATE TABLE control_plane.anthropic_session_entries (
  tenant_id text NOT NULL,
  session_id uuid NOT NULL,
  entry_sequence bigint GENERATED ALWAYS AS IDENTITY,
  project_key text NOT NULL CHECK (length(project_key) BETWEEN 1 AND 1024),
  subpath text NOT NULL DEFAULT '' CHECK (length(subpath)<=1024),
  entry_uuid text CHECK (entry_uuid IS NULL OR length(entry_uuid) BETWEEN 1 AND 128),
  entry_digest text NOT NULL CHECK (entry_digest~'^[a-f0-9]{64}$'),
  entry jsonb NOT NULL CHECK (jsonb_typeof(entry)='object' AND octet_length(entry::text)<=2097152),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,session_id,entry_sequence),
  FOREIGN KEY (tenant_id,session_id)
    REFERENCES control_plane.anthropic_conversation_sessions(tenant_id,session_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX anthropic_session_entries_uuid_unique
  ON control_plane.anthropic_session_entries(tenant_id,session_id,project_key,subpath,entry_uuid)
  WHERE entry_uuid IS NOT NULL;

CREATE UNIQUE INDEX anthropic_session_entries_digest_unique
  ON control_plane.anthropic_session_entries(tenant_id,session_id,project_key,subpath,entry_digest);

CREATE INDEX anthropic_session_entries_load_idx
  ON control_plane.anthropic_session_entries(tenant_id,session_id,project_key,subpath,entry_sequence);

ALTER TABLE control_plane.anthropic_conversation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.anthropic_conversation_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.anthropic_session_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.anthropic_session_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY anthropic_sessions_tenant_runtime
  ON control_plane.anthropic_conversation_sessions
  FOR ALL TO albert_anthropic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));

CREATE POLICY anthropic_entries_tenant_runtime
  ON control_plane.anthropic_session_entries
  FOR ALL TO albert_anthropic_control
  USING (tenant_id=current_setting('albert.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('albert.tenant_id',true));

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
    UPDATE control_plane.anthropic_conversation_sessions
       SET updated_at=now(),expires_at=greatest(expires_at,now()+interval '30 days')
     WHERE tenant_id=p_tenant_id AND session_id=active.session_id;
    session_id:=active.session_id;
    created:=false;
    RETURN NEXT;
    RETURN;
  END IF;
  IF FOUND THEN
    UPDATE control_plane.anthropic_conversation_sessions
       SET superseded_at=now(),updated_at=now()
     WHERE tenant_id=p_tenant_id AND session_id=active.session_id;
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

CREATE OR REPLACE FUNCTION control_plane.assert_anthropic_session_store_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
  SELECT to_regclass('control_plane.anthropic_conversation_sessions') IS NOT NULL
     AND to_regclass('control_plane.anthropic_session_entries') IS NOT NULL
$$;

REVOKE ALL ON TABLE control_plane.anthropic_conversation_sessions FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON TABLE control_plane.anthropic_session_entries FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.claim_anthropic_conversation_session(text,uuid,text,text,uuid,text,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.assert_anthropic_session_store_ready() FROM PUBLIC,anon,authenticated,service_role;

GRANT USAGE ON SCHEMA control_plane TO albert_anthropic_control;
GRANT SELECT,INSERT,UPDATE ON control_plane.anthropic_conversation_sessions TO albert_anthropic_control;
GRANT SELECT,INSERT ON control_plane.anthropic_session_entries TO albert_anthropic_control;
GRANT USAGE,SELECT ON SEQUENCE control_plane.anthropic_session_entries_entry_sequence_seq TO albert_anthropic_control;
GRANT EXECUTE ON FUNCTION control_plane.claim_anthropic_conversation_session(text,uuid,text,text,uuid,text,text,text,text,text) TO albert_anthropic_control;
GRANT EXECUTE ON FUNCTION control_plane.assert_anthropic_session_store_ready() TO albert_anthropic_control;

COMMIT;
