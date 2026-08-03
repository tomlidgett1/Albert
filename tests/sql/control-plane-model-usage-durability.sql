\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'model-usage assertion failed: %',message;
  END IF;
END;
$$;

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '52000000-0000-4000-8000-000000000005','authenticated','authenticated',
  'usage-owner@albert.invalid','',now(),'{}','{}',now(),now()
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','52000000-0000-4000-8000-000000000005',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"52000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant(
  'Durable Usage Tenant','Australia/Melbourne'
) \gset tenant_
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"52000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'tenant_tenant_id'
  ),
  true
);
SELECT * FROM public.begin_albert_turn(
  NULL,'01K4AAAAAAAAAAAAAAAAAAAAAA','Run a governed analysis',
  '{"model":"gpt-5.6-sol","reasoningEffort":"medium","fastMode":false,"runtime":"openai-agents-sdk"}'::jsonb
) \gset begun_
RESET ROLE;

SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated','control_plane.model_usage_outcomes','SELECT')
  AND NOT has_function_privilege(
    'authenticated',
    'control_plane.record_model_usage_checkpoint(text,uuid,text,text,text,jsonb,jsonb,text)',
    'EXECUTE'
  ),
  'browser roles must not record or inspect provider usage receipts'
);

SET LOCAL ROLE albert_semantic_control;
SELECT set_config('albert.tenant_id',:'tenant_tenant_id',true);
SELECT * FROM control_plane.record_model_usage_checkpoint(
  :'tenant_tenant_id','52000000-0000-4000-8000-000000000005'::uuid,
  :'begun_conversation_id','01K4AAAAAAAAAAAAAAAAAAAAAA','resp_usage_failure',
  '{"requests":1,"inputTokens":100,"outputTokens":20,"totalTokens":120}'::jsonb,
  '{"rateCardId":"openai-gpt-5.6-au-2026-08-03","model":"gpt-5.6-sol","fastMode":false,"requests":1,"inputTokens":100,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":20,"estimatedCostUsdMicros":100,"pricingCompleteness":"aggregate_estimate"}'::jsonb,
  'provider_completed'
) \gset provider_
SELECT * FROM control_plane.record_model_usage_checkpoint(
  :'tenant_tenant_id','52000000-0000-4000-8000-000000000005'::uuid,
  :'begun_conversation_id','01K4AAAAAAAAAAAAAAAAAAAAAA','resp_usage_failure',
  '{"requests":1,"inputTokens":100,"outputTokens":20,"totalTokens":120}'::jsonb,
  '{"rateCardId":"openai-gpt-5.6-au-2026-08-03","model":"gpt-5.6-sol","fastMode":false,"requests":1,"inputTokens":100,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":20,"estimatedCostUsdMicros":100,"pricingCompleteness":"aggregate_estimate"}'::jsonb,
  'provider_completed'
) \gset provider_retry_
SELECT * FROM control_plane.record_model_usage_checkpoint(
  :'tenant_tenant_id','52000000-0000-4000-8000-000000000005'::uuid,
  :'begun_conversation_id','01K4AAAAAAAAAAAAAAAAAAAAAA','resp_usage_failure',
  '{"requests":1,"inputTokens":100,"outputTokens":20,"totalTokens":120}'::jsonb,
  '{"rateCardId":"openai-gpt-5.6-au-2026-08-03","model":"gpt-5.6-sol","fastMode":false,"requests":1,"inputTokens":100,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":20,"estimatedCostUsdMicros":100,"pricingCompleteness":"aggregate_estimate"}'::jsonb,
  'artifact_finalization_failed'
) \gset terminal_
SELECT * FROM control_plane.record_model_usage_checkpoint(
  :'tenant_tenant_id','52000000-0000-4000-8000-000000000005'::uuid,
  :'begun_conversation_id','01K4AAAAAAAAAAAAAAAAAAAAAA','resp_usage_failure',
  '{"requests":1,"inputTokens":100,"outputTokens":20,"totalTokens":120}'::jsonb,
  '{"rateCardId":"openai-gpt-5.6-au-2026-08-03","model":"gpt-5.6-sol","fastMode":false,"requests":1,"inputTokens":100,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":20,"estimatedCostUsdMicros":100,"pricingCompleteness":"aggregate_estimate"}'::jsonb,
  'artifact_finalization_failed'
) \gset terminal_retry_
RESET ROLE;

SELECT pg_temp.assert_true(
  :'provider_idempotent_replay'='f'
  AND :'provider_retry_idempotent_replay'='t'
  AND :'terminal_idempotent_replay'='f'
  AND :'terminal_retry_idempotent_replay'='t',
  'provider and failure outcome retries must be independently idempotent'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM control_plane.model_usage_ledger
    WHERE tenant_id=:'tenant_tenant_id' AND turn_id='01K4AAAAAAAAAAAAAAAAAAAAAA')
  AND
  (SELECT count(*)=2
       AND count(*) FILTER (WHERE stage='provider' AND outcome='provider_completed')=1
       AND count(*) FILTER (WHERE stage='terminal' AND outcome='artifact_finalization_failed')=1
     FROM control_plane.model_usage_outcomes
    WHERE tenant_id=:'tenant_tenant_id' AND turn_id='01K4AAAAAAAAAAAAAAAAAAAAAA'),
  'usage must survive finalization failure with exactly one provider and terminal receipt'
);

SELECT set_config('test.usage_tenant_id',:'tenant_tenant_id',true);
SELECT set_config('test.usage_conversation_id',:'begun_conversation_id',true);
SET LOCAL ROLE albert_semantic_control;
DO $$
BEGIN
  BEGIN
    PERFORM set_config('albert.tenant_id',current_setting('test.usage_tenant_id'),true);
    PERFORM * FROM control_plane.record_model_usage_checkpoint(
      current_setting('test.usage_tenant_id'),'52000000-0000-4000-8000-000000000005'::uuid,
      current_setting('test.usage_conversation_id'),'01K4AAAAAAAAAAAAAAAAAAAAAA','resp_usage_failure',
      '{"requests":1,"inputTokens":100,"outputTokens":20,"totalTokens":120}'::jsonb,
      '{"rateCardId":"openai-gpt-5.6-au-2026-08-03","model":"gpt-5.6-sol","fastMode":false,"requests":1,"inputTokens":100,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":20,"estimatedCostUsdMicros":100,"pricingCompleteness":"aggregate_estimate"}'::jsonb,
      'client_disconnected'
    );
    RAISE EXCEPTION 'a second terminal outcome was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  BEGIN
    UPDATE control_plane.model_usage_outcomes
       SET outcome='runtime_failure'
     WHERE tenant_id=current_setting('test.usage_tenant_id')
       AND turn_id='01K4AAAAAAAAAAAAAAAAAAAAAA'
       AND stage='terminal';
    RAISE EXCEPTION 'an append-only usage outcome was mutated';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END;
$$;

ROLLBACK;
