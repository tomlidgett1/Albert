BEGIN;

CREATE TABLE control_plane.model_usage_outcomes (
  tenant_id text NOT NULL,
  usage_outcome_id text NOT NULL CHECK (control_plane.is_ulid(usage_outcome_id)),
  conversation_id text NOT NULL,
  turn_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('provider','terminal')),
  outcome text NOT NULL CHECK (outcome IN (
    'provider_completed','answer_finalized','client_disconnected','turn_timeout',
    'runtime_failure','artifact_finalization_failed'
  )),
  provider_response_id text CHECK (
    provider_response_id IS NULL OR length(provider_response_id) BETWEEN 1 AND 512
  ),
  provider_usage jsonb NOT NULL CHECK (
    jsonb_typeof(provider_usage)='object' AND octet_length(provider_usage::text)<=1048576
  ),
  provider_usage_digest text NOT NULL CHECK (provider_usage_digest~'^[a-f0-9]{64}$'),
  metering_digest text NOT NULL CHECK (metering_digest~'^[a-f0-9]{64}$'),
  recorded_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,usage_outcome_id),
  UNIQUE (tenant_id,turn_id,stage),
  FOREIGN KEY (tenant_id,turn_id)
    REFERENCES control_plane.model_usage_ledger(tenant_id,turn_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,conversation_id)
    REFERENCES control_plane.conversations(tenant_id,conversation_id) ON DELETE CASCADE,
  CHECK ((stage='provider' AND outcome='provider_completed')
      OR (stage='terminal' AND outcome<>'provider_completed'))
);

ALTER TABLE control_plane.model_usage_outcomes ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.reject_model_usage_outcome_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
BEGIN
  IF control_plane.deletion_mutation_authorized() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'control_plane.model_usage_outcomes is append-only' USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER model_usage_outcomes_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.model_usage_outcomes
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_model_usage_outcome_mutation();

CREATE FUNCTION control_plane.record_model_usage_checkpoint(
  p_tenant_id text,
  p_actor_user_id uuid,
  p_conversation_id text,
  p_turn_id text,
  p_provider_response_id text,
  p_provider_usage jsonb,
  p_metering jsonb,
  p_outcome text
)
RETURNS TABLE (
  metering_digest text,
  provider_usage_digest text,
  stage text,
  outcome text,
  idempotent_replay boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  turn_row control_plane.conversation_turns%ROWTYPE;
  resolved_metering_digest text;
  resolved_provider_usage_digest text;
  existing_metering_digest text;
  existing_provider_digest text;
  existing_outcome text;
  existing_response_id text;
  provider_replay boolean:=false;
  terminal_replay boolean:=false;
  requested_stage text:=CASE WHEN p_outcome='provider_completed' THEN 'provider' ELSE 'terminal' END;
BEGIN
  IF current_setting('albert.tenant_id',true) IS DISTINCT FROM p_tenant_id
     OR p_actor_user_id IS NULL
     OR NOT control_plane.is_ulid(p_conversation_id)
     OR NOT control_plane.is_ulid(p_turn_id)
     OR (p_provider_response_id IS NOT NULL AND length(p_provider_response_id) NOT BETWEEN 1 AND 512)
     OR p_provider_usage IS NULL
     OR jsonb_typeof(p_provider_usage)<>'object'
     OR octet_length(p_provider_usage::text)>1048576
     OR p_metering IS NULL
     OR jsonb_typeof(p_metering)<>'object'
     OR p_outcome NOT IN (
       'provider_completed','answer_finalized','client_disconnected','turn_timeout',
       'runtime_failure','artifact_finalization_failed'
     ) THEN
    RAISE EXCEPTION 'model usage checkpoint input is invalid' USING ERRCODE='22023';
  END IF;

  SELECT candidate.* INTO turn_row
    FROM control_plane.conversation_turns AS candidate
    JOIN control_plane.conversations AS conversation
      ON conversation.tenant_id=candidate.tenant_id
     AND conversation.conversation_id=candidate.conversation_id
   WHERE candidate.tenant_id=p_tenant_id
     AND candidate.conversation_id=p_conversation_id
     AND candidate.turn_id=p_turn_id
     AND candidate.created_by=p_actor_user_id
     AND conversation.created_by=p_actor_user_id
   FOR UPDATE OF candidate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation turn was not found' USING ERRCODE='P0002';
  END IF;

  IF p_metering->>'model' IS DISTINCT FROM turn_row.runtime_profile->>'model'
     OR (p_metering->>'fastMode')::boolean IS DISTINCT FROM
        coalesce((turn_row.runtime_profile->>'fastMode')::boolean,false)
     OR p_metering->>'model' NOT IN ('gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna')
     OR p_metering->>'pricingCompleteness' NOT IN ('request_level','aggregate_estimate')
     OR coalesce(p_metering->>'rateCardId','') !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
     OR coalesce(p_metering->>'requests','') !~ '^[0-9]+$'
     OR (p_metering->>'requests')::bigint<1
     OR coalesce(p_metering->>'inputTokens','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'cachedInputTokens','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'cacheWriteInputTokens','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'outputTokens','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'estimatedCostUsdMicros','') !~ '^[0-9]+$'
     OR (p_metering->>'cachedInputTokens')::bigint+(p_metering->>'cacheWriteInputTokens')::bigint>
        (p_metering->>'inputTokens')::bigint THEN
    RAISE EXCEPTION 'model metering does not match the turn' USING ERRCODE='22023';
  END IF;
  IF p_outcome='answer_finalized' AND (
    turn_row.status<>'completed' OR NOT EXISTS (
      SELECT 1 FROM control_plane.answer_artifacts AS artifact
       WHERE artifact.tenant_id=p_tenant_id AND artifact.turn_id=p_turn_id
    )
  ) THEN
    RAISE EXCEPTION 'answer-finalized usage requires its immutable artefact' USING ERRCODE='55000';
  END IF;
  IF p_outcome IN ('client_disconnected','turn_timeout','runtime_failure','artifact_finalization_failed')
     AND (turn_row.status='completed' OR EXISTS (
       SELECT 1 FROM control_plane.answer_artifacts AS artifact
        WHERE artifact.tenant_id=p_tenant_id AND artifact.turn_id=p_turn_id
     )) THEN
    RAISE EXCEPTION 'a finalized answer cannot receive a failure usage outcome' USING ERRCODE='55000';
  END IF;

  resolved_metering_digest:=encode(
    extensions.digest(convert_to(p_metering::text,'UTF8'),'sha256'),'hex'
  );
  resolved_provider_usage_digest:=encode(
    extensions.digest(convert_to(p_provider_usage::text,'UTF8'),'sha256'),'hex'
  );

  SELECT ledger.metering_digest INTO existing_metering_digest
    FROM control_plane.model_usage_ledger AS ledger
   WHERE ledger.tenant_id=p_tenant_id AND ledger.turn_id=p_turn_id;
  IF existing_metering_digest IS NOT NULL
     AND existing_metering_digest<>resolved_metering_digest THEN
    RAISE EXCEPTION 'turn usage was already recorded differently' USING ERRCODE='23505';
  END IF;
  IF existing_metering_digest IS NULL THEN
    INSERT INTO control_plane.model_usage_ledger(
      tenant_id,usage_ledger_id,conversation_id,turn_id,rate_card_id,model,
      fast_mode,requests,input_tokens,cached_input_tokens,cache_write_input_tokens,
      output_tokens,estimated_cost_usd_micros,pricing_completeness,metering_digest,recorded_by
    ) VALUES (
      p_tenant_id,control_plane.generate_ulid(),p_conversation_id,p_turn_id,
      p_metering->>'rateCardId',p_metering->>'model',(p_metering->>'fastMode')::boolean,
      (p_metering->>'requests')::integer,(p_metering->>'inputTokens')::bigint,
      (p_metering->>'cachedInputTokens')::bigint,(p_metering->>'cacheWriteInputTokens')::bigint,
      (p_metering->>'outputTokens')::bigint,(p_metering->>'estimatedCostUsdMicros')::bigint,
      p_metering->>'pricingCompleteness',resolved_metering_digest,p_actor_user_id
    );
  END IF;

  SELECT usage.provider_usage_digest,usage.metering_digest,
         usage.outcome,usage.provider_response_id
    INTO existing_provider_digest,existing_metering_digest,
         existing_outcome,existing_response_id
    FROM control_plane.model_usage_outcomes AS usage
   WHERE usage.tenant_id=p_tenant_id AND usage.turn_id=p_turn_id AND usage.stage='provider';
  IF FOUND THEN
    IF existing_provider_digest<>resolved_provider_usage_digest
       OR existing_metering_digest<>resolved_metering_digest
       OR existing_outcome<>'provider_completed'
       OR existing_response_id IS DISTINCT FROM p_provider_response_id THEN
      RAISE EXCEPTION 'provider usage checkpoint already differs' USING ERRCODE='23505';
    END IF;
    provider_replay:=true;
  ELSE
    INSERT INTO control_plane.model_usage_outcomes(
      tenant_id,usage_outcome_id,conversation_id,turn_id,stage,outcome,
      provider_response_id,provider_usage,provider_usage_digest,metering_digest,recorded_by
    ) VALUES (
      p_tenant_id,control_plane.generate_ulid(),p_conversation_id,p_turn_id,
      'provider','provider_completed',p_provider_response_id,p_provider_usage,
      resolved_provider_usage_digest,resolved_metering_digest,p_actor_user_id
    );
  END IF;

  IF requested_stage='terminal' THEN
    SELECT usage.provider_usage_digest,usage.metering_digest,
           usage.outcome,usage.provider_response_id
      INTO existing_provider_digest,existing_metering_digest,
           existing_outcome,existing_response_id
      FROM control_plane.model_usage_outcomes AS usage
     WHERE usage.tenant_id=p_tenant_id AND usage.turn_id=p_turn_id AND usage.stage='terminal';
    IF FOUND THEN
      IF existing_provider_digest<>resolved_provider_usage_digest
         OR existing_metering_digest<>resolved_metering_digest
         OR existing_outcome<>p_outcome
         OR existing_response_id IS DISTINCT FROM p_provider_response_id THEN
        RAISE EXCEPTION 'terminal usage outcome already differs' USING ERRCODE='23505';
      END IF;
      terminal_replay:=true;
    ELSE
      INSERT INTO control_plane.model_usage_outcomes(
        tenant_id,usage_outcome_id,conversation_id,turn_id,stage,outcome,
        provider_response_id,provider_usage,provider_usage_digest,metering_digest,recorded_by
      ) VALUES (
        p_tenant_id,control_plane.generate_ulid(),p_conversation_id,p_turn_id,
        'terminal',p_outcome,p_provider_response_id,p_provider_usage,
        resolved_provider_usage_digest,resolved_metering_digest,p_actor_user_id
      );
    END IF;
  END IF;

  IF (requested_stage='provider' AND NOT provider_replay)
     OR (requested_stage='terminal' AND NOT terminal_replay) THEN
    INSERT INTO control_plane.audit_log(
      tenant_id,audit_id,actor_user_id,actor_type,action,
      resource_type,resource_id,audit_metadata
    ) VALUES (
      p_tenant_id,control_plane.generate_ulid(),p_actor_user_id,'service',
      CASE WHEN requested_stage='provider' THEN 'model.provider_usage_checkpointed'
           ELSE 'model.terminal_usage_outcome_recorded' END,
      'conversation_turn',p_turn_id,
      jsonb_build_object(
        'stage',requested_stage,'outcome',p_outcome,
        'metering_digest',resolved_metering_digest,
        'provider_usage_digest',resolved_provider_usage_digest
      )
    );
  END IF;

  metering_digest:=resolved_metering_digest;
  provider_usage_digest:=resolved_provider_usage_digest;
  stage:=requested_stage;
  outcome:=p_outcome;
  idempotent_replay:=CASE WHEN requested_stage='provider'
    THEN provider_replay ELSE terminal_replay END;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON TABLE control_plane.model_usage_outcomes
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.record_model_usage_checkpoint(
  text,uuid,text,text,text,jsonb,jsonb,text
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION control_plane.record_model_usage_checkpoint(
  text,uuid,text,text,text,jsonb,jsonb,text
) TO albert_semantic_control;

COMMENT ON TABLE control_plane.model_usage_outcomes IS
  'Append-only provider completion and terminal turn outcomes. Cost attribution commits before answer-artifact finalization and survives its failure.';

COMMIT;
