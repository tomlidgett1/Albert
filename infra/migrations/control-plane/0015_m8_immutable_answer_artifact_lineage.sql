BEGIN;

-- One finalized, content-addressed artefact per completed assistant turn. The
-- deterministic SQL remains in the analytical query audit; the control plane
-- stores immutable hashes and opaque references, so neither browser nor model
-- receives an SQL surface.
ALTER TABLE control_plane.answer_artifacts
  ADD COLUMN IF NOT EXISTS turn_id text,
  ADD COLUMN IF NOT EXISTS trace_digest text,
  ADD COLUMN IF NOT EXISTS artifact_digest text,
  ADD COLUMN IF NOT EXISTS query_executions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS runtime_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provider_response_id text,
  ADD COLUMN IF NOT EXISTS provider_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS model_usage_digest text,
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz;

ALTER TABLE control_plane.answer_artifacts
  DROP CONSTRAINT IF EXISTS answer_artifacts_turn_fk,
  ADD CONSTRAINT answer_artifacts_turn_fk
    FOREIGN KEY (tenant_id,turn_id)
    REFERENCES control_plane.conversation_turns(tenant_id,turn_id)
    ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS answer_artifacts_trace_digest_check,
  ADD CONSTRAINT answer_artifacts_trace_digest_check
    CHECK (trace_digest IS NULL OR trace_digest ~ '^[a-f0-9]{64}$'),
  DROP CONSTRAINT IF EXISTS answer_artifacts_artifact_digest_check,
  ADD CONSTRAINT answer_artifacts_artifact_digest_check
    CHECK (artifact_digest IS NULL OR artifact_digest ~ '^[a-f0-9]{64}$'),
  DROP CONSTRAINT IF EXISTS answer_artifacts_query_executions_check,
  ADD CONSTRAINT answer_artifacts_query_executions_check
    CHECK (jsonb_typeof(query_executions)='array'),
  DROP CONSTRAINT IF EXISTS answer_artifacts_runtime_profile_check,
  ADD CONSTRAINT answer_artifacts_runtime_profile_check
    CHECK (jsonb_typeof(runtime_profile)='object'),
  DROP CONSTRAINT IF EXISTS answer_artifacts_provider_usage_check,
  ADD CONSTRAINT answer_artifacts_provider_usage_check
    CHECK (jsonb_typeof(provider_usage)='object'),
  DROP CONSTRAINT IF EXISTS answer_artifacts_model_usage_digest_check,
  ADD CONSTRAINT answer_artifacts_model_usage_digest_check
    CHECK (model_usage_digest IS NULL OR model_usage_digest ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS answer_artifacts_one_per_turn
  ON control_plane.answer_artifacts(tenant_id,turn_id)
  WHERE turn_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS answer_artifacts_content_address
  ON control_plane.answer_artifacts(tenant_id,artifact_digest)
  WHERE artifact_digest IS NOT NULL;

ALTER TABLE control_plane.answer_execution_events
  ADD COLUMN IF NOT EXISTS source_turn_event_id text,
  ADD COLUMN IF NOT EXISTS conversation_id text,
  ADD COLUMN IF NOT EXISTS turn_id text;

ALTER TABLE control_plane.answer_execution_events
  DROP CONSTRAINT IF EXISTS answer_execution_events_source_event_fk,
  ADD CONSTRAINT answer_execution_events_source_event_fk
    FOREIGN KEY (tenant_id,source_turn_event_id)
    REFERENCES control_plane.conversation_turn_events(tenant_id,turn_event_id)
    ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS answer_execution_events_turn_fk,
  ADD CONSTRAINT answer_execution_events_turn_fk
    FOREIGN KEY (tenant_id,turn_id)
    REFERENCES control_plane.conversation_turns(tenant_id,turn_id)
    ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS answer_execution_events_source_unique
  ON control_plane.answer_execution_events(tenant_id,source_turn_event_id)
  WHERE source_turn_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS answer_execution_events_turn_order_idx
  ON control_plane.answer_execution_events(tenant_id,turn_id,sequence_number);

-- Raw normalized IR and evidence bindings are server-side audit material.
-- Tenant clients receive only the safe explanation projection below.
REVOKE SELECT ON TABLE control_plane.answer_artifacts,
  control_plane.answer_execution_events FROM authenticated,anon,service_role;
DROP POLICY IF EXISTS tenant_members_read ON control_plane.answer_artifacts;
DROP POLICY IF EXISTS tenant_members_read ON control_plane.answer_execution_events;

COMMENT ON COLUMN control_plane.answer_artifacts.query_executions IS
  'Immutable normalized IR, analytical query-audit reference, bundle/result hashes, compiled-SQL hash and validation for each query. Raw SQL remains only in semantic_internal.query_audit.';
COMMENT ON COLUMN control_plane.answer_artifacts.trace_digest IS
  'SHA-256 over the exact ordered public trace copied into answer_execution_events.';
COMMENT ON COLUMN control_plane.answer_artifacts.artifact_digest IS
  'SHA-256 over the canonical finalized answer document, including trace and query evidence digests.';

CREATE OR REPLACE FUNCTION control_plane.reject_answer_lineage_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
BEGIN
  IF control_plane.deletion_mutation_authorized() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'answer lineage is immutable after finalization' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS answer_artifacts_reject_mutation
  ON control_plane.answer_artifacts;
CREATE TRIGGER answer_artifacts_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.answer_artifacts
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_answer_lineage_mutation();

DROP TRIGGER IF EXISTS answer_execution_events_reject_mutation
  ON control_plane.answer_execution_events;
CREATE TRIGGER answer_execution_events_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.answer_execution_events
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_answer_lineage_mutation();

REVOKE ALL ON FUNCTION control_plane.reject_answer_lineage_mutation() FROM PUBLIC;

CREATE OR REPLACE FUNCTION control_plane.finalize_answer_artifact(
  p_tenant_id text,
  p_actor_user_id uuid,
  p_conversation_id text,
  p_turn_id text,
  p_provider_response_id text,
  p_provider_usage jsonb,
  p_answer_state text,
  p_turn_result_digest text,
  p_metering jsonb,
  p_query_executions jsonb
)
RETURNS TABLE (
  answer_artifact_id text,
  artifact_digest text,
  idempotent_replay boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  turn_row control_plane.conversation_turns%ROWTYPE;
  final_event jsonb;
  trace_document jsonb;
  interpreted_plan_document jsonb;
  validation_document jsonb;
  provenance_document jsonb;
  semantic_ir_document jsonb;
  result_digest_document jsonb;
  artifact_document jsonb;
  query_item jsonb;
  query_count integer;
  distinct_query_count integer;
  distinct_bundle_count integer;
  resolved_bundle_hash text;
  resolved_answer_text text;
  resolved_trace_digest text;
  resolved_artifact_digest text;
  resolved_metering_digest text;
  existing_artifact_id text;
  existing_artifact_digest text;
  existing_usage_digest text;
  created_artifact_id text;
BEGIN
  IF current_setting('albert.tenant_id',true) IS DISTINCT FROM p_tenant_id
     OR NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_conversation_id)
     OR NOT control_plane.is_ulid(p_turn_id)
     OR p_actor_user_id IS NULL
     OR p_provider_response_id IS NULL
     OR length(btrim(p_provider_response_id)) NOT BETWEEN 1 AND 512
     OR p_provider_usage IS NULL OR jsonb_typeof(p_provider_usage)<>'object'
     OR octet_length(p_provider_usage::text)>1048576
     OR p_answer_state NOT IN ('verified','qualified','exploratory','clarification','unavailable')
     OR p_turn_result_digest !~ '^sha256:[a-f0-9]{64}$'
     OR p_metering IS NULL OR jsonb_typeof(p_metering)<>'object'
     OR p_query_executions IS NULL OR jsonb_typeof(p_query_executions)<>'array'
     OR jsonb_array_length(p_query_executions)>20
     OR octet_length(p_query_executions::text)>2097152 THEN
    RAISE EXCEPTION 'answer artefact finalization input is invalid' USING ERRCODE='22023';
  END IF;

  query_count := jsonb_array_length(p_query_executions);
  SELECT count(DISTINCT item->>'queryAuditId')
    INTO distinct_query_count
    FROM jsonb_array_elements(p_query_executions) AS item;
  IF distinct_query_count<>query_count THEN
    RAISE EXCEPTION 'query audit references must be unique' USING ERRCODE='22023';
  END IF;

  FOR query_item IN SELECT value FROM jsonb_array_elements(p_query_executions) LOOP
    IF jsonb_typeof(query_item)<>'object'
       OR NOT control_plane.is_ulid(coalesce(query_item->>'queryAuditId',''))
       OR coalesce(query_item->>'route','') NOT IN ('semantic','source_exploration')
       OR coalesce(query_item->>'bundleHash','') !~ '^[a-f0-9]{64}$'
       OR length(coalesce(query_item->>'registryVersion','')) NOT BETWEEN 1 AND 160
       OR jsonb_typeof(query_item->'normalizedIr')<>'object'
       OR coalesce(query_item->>'compilerOutputHash','') !~ '^[a-f0-9]{64}$'
       OR coalesce(query_item->>'resultDigest','') !~ '^[a-f0-9]{64}$'
       OR coalesce(query_item->>'answerState','') NOT IN ('verified','qualified','exploratory','clarification','unavailable')
       OR jsonb_typeof(query_item->'validation')<>'object' THEN
      RAISE EXCEPTION 'query execution evidence is malformed' USING ERRCODE='22023';
    END IF;
  END LOOP;

  IF p_answer_state IN ('verified','qualified','exploratory') AND query_count=0 THEN
    RAISE EXCEPTION 'analytical answers require query evidence' USING ERRCODE='22023';
  END IF;
  IF p_answer_state='clarification' AND query_count<>0 THEN
    RAISE EXCEPTION 'clarifications cannot contain query evidence' USING ERRCODE='22023';
  END IF;
  IF p_answer_state='exploratory' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_query_executions) item
     WHERE item->>'route'='source_exploration'
  ) THEN
    RAISE EXCEPTION 'exploratory answers require source evidence' USING ERRCODE='22023';
  END IF;
  IF p_answer_state='verified' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_query_executions) item
     WHERE item->>'route'='source_exploration'
  ) THEN
    RAISE EXCEPTION 'verified answers cannot rely on source exploration' USING ERRCODE='22023';
  END IF;

  -- Linearize finalization against both tenant erasure and connection
  -- disconnect. Tenant deletion approval locks the tenant before setting it to
  -- deleting; disconnect updates the connection before creating its deletion
  -- request. Holding these locks through commit means finalization is either
  -- wholly before deletion (and will subsequently be purged) or is rejected.
  PERFORM 1
    FROM control_plane.tenants tenant
   WHERE tenant.tenant_id=p_tenant_id AND tenant.status='active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'answer finalization fenced by tenant deletion' USING ERRCODE='55000';
  END IF;
  PERFORM 1
    FROM control_plane.connections connection
   WHERE connection.tenant_id=p_tenant_id
   FOR SHARE;
  IF EXISTS (
    SELECT 1
      FROM control_plane.deletion_requests request
     WHERE request.tenant_id=p_tenant_id
       AND request.status IN ('queued','running','retry_wait','verifying','failed')
  ) THEN
    RAISE EXCEPTION 'answer finalization fenced by deletion' USING ERRCODE='55000';
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
  IF turn_row.status NOT IN ('running','completed') THEN
    RAISE EXCEPTION 'only a running or identically completed turn can be finalized' USING ERRCODE='55000';
  END IF;

  SELECT coalesce(jsonb_agg(event.event ORDER BY event.sequence_number),'[]'::jsonb)
    INTO trace_document
    FROM control_plane.conversation_turn_events AS event
   WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id;
  IF jsonb_array_length(trace_document)=0 THEN
    RAISE EXCEPTION 'a finalized answer requires a persisted public trace' USING ERRCODE='55000';
  END IF;
  SELECT event.event INTO final_event
    FROM control_plane.conversation_turn_events AS event
   WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id
     AND event.event->>'type' IN ('answer','clarification')
   ORDER BY event.sequence_number DESC LIMIT 1;
  IF final_event IS NULL
     OR (p_answer_state='clarification' AND final_event->>'type'<>'clarification')
     OR (p_answer_state<>'clarification' AND final_event->>'type'<>'answer')
     OR lower(coalesce(final_event->>'state',p_answer_state))<>p_answer_state THEN
    RAISE EXCEPTION 'answer state does not match the final visible trace event' USING ERRCODE='22023';
  END IF;

  resolved_answer_text := CASE WHEN final_event->>'type'='clarification'
    THEN final_event->>'question' ELSE final_event->>'text' END;
  IF length(btrim(coalesce(resolved_answer_text,''))) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'final visible narrative is missing or invalid' USING ERRCODE='22023';
  END IF;

  -- Every visible table bundle must be represented by an authoritative
  -- analytical audit row supplied by the constrained semantic runtime.
  IF EXISTS (
    SELECT 1
      FROM control_plane.conversation_turn_events event
     WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id
       AND event.event->>'type'='table'
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_query_executions) query
          WHERE query->>'bundleHash'=event.event#>>'{provenance,semanticBundleHash}'
       )
  ) THEN
    RAISE EXCEPTION 'a visible result table is missing immutable query evidence' USING ERRCODE='22023';
  END IF;

  SELECT jsonb_build_object(
    'kind','visible_execution_plan',
    'steps',coalesce(jsonb_agg(event.event ORDER BY event.sequence_number)
      FILTER (WHERE event.event->>'type' IN ('progress','narrative','query')),'[]'::jsonb)
  ) INTO interpreted_plan_document
    FROM control_plane.conversation_turn_events AS event
   WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id;

  SELECT coalesce(jsonb_agg(event.event ORDER BY event.sequence_number)
    FILTER (WHERE event.event->>'type'='validation'),'[]'::jsonb)
    INTO validation_document
    FROM control_plane.conversation_turn_events AS event
   WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id;

  provenance_document := coalesce(final_event->'provenance',(
    SELECT event.event->'provenance'
      FROM control_plane.conversation_turn_events AS event
     WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id
       AND event.event->>'type'='table'
     ORDER BY event.sequence_number DESC LIMIT 1
  ),'{}'::jsonb);

  semantic_ir_document := CASE WHEN query_count=0 THEN NULL ELSE jsonb_build_object(
    'queries',(
      SELECT jsonb_agg(jsonb_build_object(
        'queryAuditId',query->>'queryAuditId','normalizedIr',query->'normalizedIr'
      ) ORDER BY ordinal)
      FROM jsonb_array_elements(p_query_executions) WITH ORDINALITY AS source(query,ordinal)
    )
  ) END;
  result_digest_document := jsonb_build_object(
    'turn',p_turn_result_digest,
    'queries',(
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'queryAuditId',query->>'queryAuditId','resultDigest',query->>'resultDigest'
      ) ORDER BY ordinal),'[]'::jsonb)
      FROM jsonb_array_elements(p_query_executions) WITH ORDINALITY AS source(query,ordinal)
    )
  );
  SELECT count(DISTINCT query->>'bundleHash'),min(query->>'bundleHash')
    INTO distinct_bundle_count,resolved_bundle_hash
    FROM jsonb_array_elements(p_query_executions) query;
  IF distinct_bundle_count<>1 THEN resolved_bundle_hash:=NULL; END IF;

  resolved_trace_digest := encode(extensions.digest(convert_to(trace_document::text,'UTF8'),'sha256'),'hex');
  resolved_metering_digest := encode(extensions.digest(convert_to(p_metering::text,'UTF8'),'sha256'),'hex');
  artifact_document := jsonb_build_object(
    'schemaVersion',1,
    'tenantId',p_tenant_id,
    'conversationId',p_conversation_id,
    'turnId',p_turn_id,
    'turnNumber',turn_row.turn_number,
    'questionText',turn_row.user_message,
    'answerState',p_answer_state,
    'finalNarrative',resolved_answer_text,
    'interpretedPlan',interpreted_plan_document,
    'semanticIr',semantic_ir_document,
    'queryExecutions',p_query_executions,
    'resultDigest',result_digest_document,
    'validationOutcomes',validation_document,
    'provenance',provenance_document,
    'semanticBundleHash',resolved_bundle_hash,
    'traceDigest',resolved_trace_digest,
    'runtimeProfile',turn_row.runtime_profile,
    'providerResponseId',p_provider_response_id,
    'providerUsage',p_provider_usage,
    'modelUsageDigest',resolved_metering_digest
  );
  resolved_artifact_digest := encode(extensions.digest(convert_to(artifact_document::text,'UTF8'),'sha256'),'hex');

  SELECT artifact.answer_artifact_id,artifact.artifact_digest
    INTO existing_artifact_id,existing_artifact_digest
    FROM control_plane.answer_artifacts artifact
   WHERE artifact.tenant_id=p_tenant_id AND artifact.turn_id=p_turn_id;
  IF existing_artifact_id IS NOT NULL THEN
    IF existing_artifact_digest IS DISTINCT FROM resolved_artifact_digest
       OR turn_row.status<>'completed' THEN
      RAISE EXCEPTION 'turn was already finalized with different evidence' USING ERRCODE='23505';
    END IF;
    answer_artifact_id:=existing_artifact_id;
    artifact_digest:=existing_artifact_digest;
    idempotent_replay:=true;
    RETURN NEXT;
    RETURN;
  END IF;
  IF turn_row.status<>'running' THEN
    RAISE EXCEPTION 'completed turn is missing its immutable answer artefact' USING ERRCODE='55000';
  END IF;

  IF p_metering->>'model' IS DISTINCT FROM turn_row.runtime_profile->>'model'
     OR (p_metering->>'fastMode')::boolean IS DISTINCT FROM
        coalesce((turn_row.runtime_profile->>'fastMode')::boolean,false)
     OR p_metering->>'model' NOT IN ('gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna')
     OR p_metering->>'pricingCompleteness' NOT IN ('request_level','aggregate_estimate')
     OR coalesce(p_metering->>'rateCardId','') !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
     OR coalesce(p_metering->>'requests','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'inputTokens','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'cachedInputTokens','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'cacheWriteInputTokens','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'outputTokens','') !~ '^[0-9]+$'
     OR coalesce(p_metering->>'estimatedCostUsdMicros','') !~ '^[0-9]+$'
     OR (p_metering->>'cachedInputTokens')::bigint+(p_metering->>'cacheWriteInputTokens')::bigint>
        (p_metering->>'inputTokens')::bigint THEN
    RAISE EXCEPTION 'model metering does not match the turn' USING ERRCODE='22023';
  END IF;

  SELECT ledger.metering_digest INTO existing_usage_digest
    FROM control_plane.model_usage_ledger ledger
   WHERE ledger.tenant_id=p_tenant_id AND ledger.turn_id=p_turn_id;
  IF existing_usage_digest IS NOT NULL AND existing_usage_digest<>resolved_metering_digest THEN
    RAISE EXCEPTION 'turn usage was already recorded differently' USING ERRCODE='23505';
  END IF;
  IF existing_usage_digest IS NULL THEN
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

  created_artifact_id:=control_plane.generate_ulid();
  INSERT INTO control_plane.answer_artifacts(
    tenant_id,answer_artifact_id,conversation_id,turn_id,turn_number,answer_state,
    question_text,answer_text,interpreted_plan,semantic_ir,compiled_sql,result_digest,
    validation_outcomes,provenance,semantic_bundle_hash,trace_digest,artifact_digest,
    query_executions,runtime_profile,provider_response_id,provider_usage,
    model_usage_digest,finalized_at
  ) VALUES (
    p_tenant_id,created_artifact_id,p_conversation_id,p_turn_id,turn_row.turn_number,p_answer_state,
    turn_row.user_message,resolved_answer_text,interpreted_plan_document,semantic_ir_document,NULL,
    result_digest_document,validation_document,provenance_document,resolved_bundle_hash,
    resolved_trace_digest,resolved_artifact_digest,p_query_executions,turn_row.runtime_profile,
    p_provider_response_id,p_provider_usage,resolved_metering_digest,now()
  );

  INSERT INTO control_plane.answer_execution_events(
    tenant_id,execution_event_id,answer_artifact_id,source_turn_event_id,
    conversation_id,turn_id,sequence_number,event_type,event_payload,occurred_at
  )
  SELECT event.tenant_id,control_plane.generate_ulid(),created_artifact_id,event.turn_event_id,
         event.conversation_id,event.turn_id,event.sequence_number,event.event->>'type',
         event.event,event.occurred_at
    FROM control_plane.conversation_turn_events event
   WHERE event.tenant_id=p_tenant_id AND event.turn_id=p_turn_id
   ORDER BY event.sequence_number;

  UPDATE control_plane.conversation_turns
     SET status='completed',provider_response_id=p_provider_response_id,
         usage=p_provider_usage,answer_state=p_answer_state,
         result_digest=p_turn_result_digest,completed_at=now()
   WHERE tenant_id=p_tenant_id AND turn_id=p_turn_id AND status='running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'running turn changed during finalization' USING ERRCODE='40001';
  END IF;
  UPDATE control_plane.conversations SET updated_at=now()
   WHERE tenant_id=p_tenant_id AND conversation_id=p_conversation_id;

  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,resource_type,resource_id,audit_metadata
  ) VALUES (
    p_tenant_id,control_plane.generate_ulid(),p_actor_user_id,'user',
    'answer_artifact.finalized','answer_artifact',created_artifact_id,
    jsonb_build_object('turn_id',p_turn_id,'answer_state',p_answer_state,
      'artifact_digest',resolved_artifact_digest,'trace_digest',resolved_trace_digest,
      'query_count',query_count,'model_usage_digest',resolved_metering_digest)
  );

  answer_artifact_id:=created_artifact_id;
  artifact_digest:=resolved_artifact_digest;
  idempotent_replay:=false;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.finalize_answer_artifact(
  text,uuid,text,text,text,jsonb,text,text,jsonb,jsonb
) FROM PUBLIC,authenticated,anon,service_role;
GRANT EXECUTE ON FUNCTION control_plane.finalize_answer_artifact(
  text,uuid,text,text,text,jsonb,text,text,jsonb,jsonb
) TO albert_semantic_control;

-- The legacy browser-callable completion RPC cannot establish analytical
-- lineage and is therefore retired. Failed-turn finalization remains public.
REVOKE EXECUTE ON FUNCTION public.complete_albert_turn(text,text,text,jsonb,text,text)
  FROM authenticated,anon,service_role;
REVOKE EXECUTE ON FUNCTION public.record_albert_model_usage(text,text,jsonb)
  FROM authenticated,anon,service_role;

CREATE OR REPLACE FUNCTION public.albert_answer_lineage(p_answer_artifact_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  actor uuid:=auth.uid();
  selected_tenant text:=control_plane.require_current_tenant_id();
  result jsonb;
BEGIN
  IF actor IS NULL OR NOT control_plane.is_ulid(p_answer_artifact_id) THEN
    RAISE EXCEPTION 'answer lineage request is invalid' USING ERRCODE='22023';
  END IF;
  SELECT jsonb_build_object(
    'answerArtifactId',artifact.answer_artifact_id,
    'conversationId',artifact.conversation_id,
    'turnId',artifact.turn_id,
    'turnNumber',artifact.turn_number,
    'answerState',artifact.answer_state,
    'question',artifact.question_text,
    'finalNarrative',artifact.answer_text,
    'interpretedPlan',artifact.interpreted_plan,
    'validationOutcomes',artifact.validation_outcomes,
    'provenance',artifact.provenance,
    'semanticBundleHash',artifact.semantic_bundle_hash,
    'traceDigest',artifact.trace_digest,
    'artifactDigest',artifact.artifact_digest,
    'queries',(
      SELECT coalesce(jsonb_agg(
        (query - 'normalizedIr') ORDER BY ordinal
      ),'[]'::jsonb)
      FROM jsonb_array_elements(artifact.query_executions) WITH ORDINALITY AS source(query,ordinal)
    ),
    'finalizedAt',artifact.finalized_at
  ) INTO result
    FROM control_plane.answer_artifacts artifact
    JOIN control_plane.conversations conversation
      ON conversation.tenant_id=artifact.tenant_id
     AND conversation.conversation_id=artifact.conversation_id
   WHERE artifact.tenant_id=selected_tenant
     AND artifact.answer_artifact_id=p_answer_artifact_id
     AND conversation.created_by=actor;
  IF result IS NULL THEN
    RAISE EXCEPTION 'answer lineage was not found' USING ERRCODE='P0002';
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_answer_lineage(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_answer_lineage(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.albert_turn_answer_lineage(
  p_conversation_id text,
  p_turn_id text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  actor uuid:=auth.uid();
  selected_tenant text:=control_plane.require_current_tenant_id();
  selected_artifact_id text;
BEGIN
  IF actor IS NULL OR NOT control_plane.is_ulid(p_conversation_id)
     OR NOT control_plane.is_ulid(p_turn_id) THEN
    RAISE EXCEPTION 'turn lineage request is invalid' USING ERRCODE='22023';
  END IF;
  SELECT artifact.answer_artifact_id INTO selected_artifact_id
    FROM control_plane.answer_artifacts artifact
    JOIN control_plane.conversations conversation
      ON conversation.tenant_id=artifact.tenant_id
     AND conversation.conversation_id=artifact.conversation_id
   WHERE artifact.tenant_id=selected_tenant
     AND artifact.conversation_id=p_conversation_id
     AND artifact.turn_id=p_turn_id
     AND conversation.created_by=actor;
  IF selected_artifact_id IS NULL THEN
    RAISE EXCEPTION 'turn answer lineage was not found' USING ERRCODE='P0002';
  END IF;
  RETURN public.albert_answer_lineage(selected_artifact_id);
END;
$$;

REVOKE ALL ON FUNCTION public.albert_turn_answer_lineage(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_turn_answer_lineage(text,text) TO authenticated;

COMMIT;
