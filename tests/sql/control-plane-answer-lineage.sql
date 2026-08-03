\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'answer-lineage assertion failed: %',message;
  END IF;
END;
$$;

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES
  ('30000000-0000-4000-8000-000000000003','authenticated','authenticated',
   'lineage-one@albert.invalid','',now(),'{}','{}',now(),now()),
  ('40000000-0000-4000-8000-000000000004','authenticated','authenticated',
   'lineage-two@albert.invalid','',now(),'{}','{}',now(),now());

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant('Lineage Tenant One','Australia/Melbourne') \gset tenant_one_
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'tenant_one_tenant_id'
  ),
  true
);
SELECT * FROM public.begin_albert_turn(
  NULL,
  '01K2ZZZZZZ0000000000000001',
  'How were governed sales yesterday?',
  '{"model":"gpt-5.6-sol","reasoningEffort":"medium","fastMode":false,"runtime":"openai-agents-sdk"}'::jsonb
) \gset begun_

SELECT public.albert_answer_event_append(
  :'begun_conversation_id','01K2ZZZZZZ0000000000000001',
  '{"id":"event-1","sequence":1,"occurredAt":"2026-08-03T01:00:00Z","type":"progress","status":"running","label":"Understanding the question"}'::jsonb
);
SELECT public.albert_answer_event_append(
  :'begun_conversation_id','01K2ZZZZZZ0000000000000001',
  '{"id":"event-2","sequence":2,"occurredAt":"2026-08-03T01:00:01Z","type":"query","status":"complete","topic":"sales_performance","metrics":["commerce.net_sales_ex_gst"],"dimensions":["business_date"],"timeRange":{"label":"Yesterday","start":"2026-08-02T00:00:00Z","end":"2026-08-03T00:00:00Z","timezone":"Australia/Melbourne"},"lens":"Net sales excluding GST"}'::jsonb
);
SELECT public.albert_answer_event_append(
  :'begun_conversation_id','01K2ZZZZZZ0000000000000001',
  jsonb_build_object(
    'id','event-3','sequence',3,'occurredAt','2026-08-03T01:00:02Z',
    'type','table','status','complete','caption','Sales · Yesterday',
    'columns',jsonb_build_array(jsonb_build_object('key','net_sales_ex_gst','label','Net sales','type','currency')),
    'rows',jsonb_build_array(jsonb_build_object('net_sales_ex_gst','210.0000')),
    'resultId','semantic:'||repeat('a',64),
    'provenance',jsonb_build_object(
      'sources',jsonb_build_array(jsonb_build_object('connector','lightspeed','label','Lightspeed','dataThrough','2026-08-03T00:55:00Z')),
      'timeRange',jsonb_build_object('label','Yesterday','start','2026-08-02T00:00:00Z','end','2026-08-03T00:00:00Z','timezone','Australia/Melbourne'),
      'definitions',jsonb_build_array(jsonb_build_object('metric','commerce.net_sales_ex_gst','label','Net sales','definition','Completed sales excluding GST.')),
      'semanticBundleHash',repeat('a',64),
      'identityGraph',jsonb_build_object('version',0,'hash','d41d8cd98f00b204e9800998ecf8427e')
    )
  )
);
SELECT public.albert_answer_event_append(
  :'begun_conversation_id','01K2ZZZZZZ0000000000000001',
  '{"id":"event-4","sequence":4,"occurredAt":"2026-08-03T01:00:03Z","type":"validation","status":"complete","name":"no_fanout","outcome":"passed","detail":"No fan-out was introduced."}'::jsonb
);
SELECT public.albert_answer_event_append(
  :'begun_conversation_id','01K2ZZZZZZ0000000000000001',
  jsonb_build_object(
    'id','event-5','sequence',5,'occurredAt','2026-08-03T01:00:04Z',
    'type','answer','status','complete','state','Verified','text','Governed net sales were $210.00 yesterday.',
    'provenance',jsonb_build_object(
      'sources',jsonb_build_array(jsonb_build_object('connector','lightspeed','label','Lightspeed','dataThrough','2026-08-03T00:55:00Z')),
      'timeRange',jsonb_build_object('label','Yesterday','start','2026-08-02T00:00:00Z','end','2026-08-03T00:00:00Z','timezone','Australia/Melbourne'),
      'definitions',jsonb_build_array(jsonb_build_object('metric','commerce.net_sales_ex_gst','label','Net sales','definition','Completed sales excluding GST.')),
      'semanticBundleHash',repeat('a',64),
      'identityGraph',jsonb_build_object('version',0,'hash','d41d8cd98f00b204e9800998ecf8427e')
    ),
    'followUps',jsonb_build_array('Compare with last week')
  )
);
RESET ROLE;

SELECT pg_temp.assert_true(
  NOT has_function_privilege('authenticated','public.complete_albert_turn(text,text,text,jsonb,text,text)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.record_albert_model_usage(text,text,jsonb)','EXECUTE')
  AND NOT has_function_privilege(
    'authenticated',
    'control_plane.finalize_answer_artifact(text,uuid,text,text,text,jsonb,text,text,jsonb,jsonb)',
    'EXECUTE'
  ),
  'browser roles must not finalize successful turns or model usage'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated','control_plane.answer_artifacts','SELECT')
  AND NOT has_table_privilege('authenticated','control_plane.answer_execution_events','SELECT')
  AND has_function_privilege('authenticated','public.albert_answer_lineage(text)','EXECUTE')
  AND has_function_privilege('authenticated','public.albert_turn_answer_lineage(text,text)','EXECUTE'),
  'browser roles must use the safe projection rather than raw audit tables'
);
SELECT pg_temp.assert_true(
  has_function_privilege(
    'albert_semantic_control',
    'control_plane.finalize_answer_artifact(text,uuid,text,text,text,jsonb,text,text,jsonb,jsonb)',
    'EXECUTE'
  )
  AND NOT has_table_privilege('albert_semantic_control','control_plane.answer_artifacts','INSERT'),
  'semantic runtime must receive only the fixed finalization function'
);

SET LOCAL ROLE albert_semantic_control;
SELECT set_config('albert.tenant_id',:'tenant_one_tenant_id',true);
SELECT * FROM control_plane.finalize_answer_artifact(
  :'tenant_one_tenant_id',
  '30000000-0000-4000-8000-000000000003'::uuid,
  :'begun_conversation_id',
  '01K2ZZZZZZ0000000000000001',
  'resp_lineage_1',
  '{"requests":1,"inputTokens":20,"outputTokens":10}'::jsonb,
  'verified',
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  '{"rateCardId":"openai-2026.08.03","model":"gpt-5.6-sol","fastMode":false,"requests":1,"inputTokens":20,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":10,"estimatedCostUsdMicros":100,"pricingCompleteness":"request_level"}'::jsonb,
  jsonb_build_array(jsonb_build_object(
    'queryAuditId','01K2ZZZZZZ0000000000000002',
    'route','semantic','topic','sales_performance','bundleHash',repeat('a',64),
    'registryVersion','2026.08.03',
    'normalizedIr',jsonb_build_object('kind','single','topic','sales_performance','metrics',jsonb_build_array('commerce.net_sales_ex_gst')),
    'compilerOutputHash',repeat('b',64),'resultDigest',repeat('c',64),
    'answerState','verified',
    'validation',jsonb_build_object('status','passed','checks',jsonb_build_array(
      jsonb_build_object('checkId','no_fanout','status','passed'),
      jsonb_build_object('checkId','grain_compatible_ratios','status','passed'),
      jsonb_build_object('checkId','snapshot_not_summed','status','passed'),
      jsonb_build_object('checkId','authority_respected','status','passed'),
      jsonb_build_object('checkId','golden_fixture_match','status','passed')
    ))
  ))
) \gset finalized_
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT status='completed' AND answer_state='verified'
     FROM control_plane.conversation_turns
    WHERE tenant_id=:'tenant_one_tenant_id' AND turn_id='01K2ZZZZZZ0000000000000001'),
  'finalization must complete the turn atomically'
);
SELECT pg_temp.assert_true(
  (SELECT compiled_sql IS NULL
       AND trace_digest~'^[a-f0-9]{64}$'
       AND artifact_digest=:'finalized_artifact_digest'
       AND query_executions#>>'{0,queryAuditId}'='01K2ZZZZZZ0000000000000002'
       AND query_executions#>>'{0,validation,status}'='passed'
     FROM control_plane.answer_artifacts
    WHERE tenant_id=:'tenant_one_tenant_id'
      AND answer_artifact_id=:'finalized_answer_artifact_id'),
  'answer artefact must bind query evidence while keeping raw SQL out of the control plane'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=5 AND min(sequence_number)=1 AND max(sequence_number)=5
     FROM control_plane.answer_execution_events
    WHERE tenant_id=:'tenant_one_tenant_id'
      AND answer_artifact_id=:'finalized_answer_artifact_id'),
  'the exact ordered visible trace must be copied into the immutable execution ledger'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1 FROM control_plane.model_usage_ledger
    WHERE tenant_id=:'tenant_one_tenant_id' AND turn_id='01K2ZZZZZZ0000000000000001'),
  'model usage must commit in the same finalization transaction'
);

SET LOCAL ROLE albert_semantic_control;
SELECT set_config('albert.tenant_id',:'tenant_one_tenant_id',true);
SELECT * FROM control_plane.finalize_answer_artifact(
  :'tenant_one_tenant_id','30000000-0000-4000-8000-000000000003'::uuid,
  :'begun_conversation_id','01K2ZZZZZZ0000000000000001','resp_lineage_1',
  '{"requests":1,"inputTokens":20,"outputTokens":10}'::jsonb,'verified',
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  '{"rateCardId":"openai-2026.08.03","model":"gpt-5.6-sol","fastMode":false,"requests":1,"inputTokens":20,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":10,"estimatedCostUsdMicros":100,"pricingCompleteness":"request_level"}'::jsonb,
  jsonb_build_array(jsonb_build_object(
    'queryAuditId','01K2ZZZZZZ0000000000000002','route','semantic','topic','sales_performance',
    'bundleHash',repeat('a',64),'registryVersion','2026.08.03',
    'normalizedIr',jsonb_build_object('kind','single','topic','sales_performance','metrics',jsonb_build_array('commerce.net_sales_ex_gst')),
    'compilerOutputHash',repeat('b',64),'resultDigest',repeat('c',64),'answerState','verified',
    'validation',jsonb_build_object('status','passed','checks',jsonb_build_array(
      jsonb_build_object('checkId','no_fanout','status','passed'),
      jsonb_build_object('checkId','grain_compatible_ratios','status','passed'),
      jsonb_build_object('checkId','snapshot_not_summed','status','passed'),
      jsonb_build_object('checkId','authority_respected','status','passed'),
      jsonb_build_object('checkId','golden_fixture_match','status','passed')
    ))
  ))
) \gset replay_
SELECT set_config('test.lineage_conversation_id',:'begun_conversation_id',true);
DO $$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    PERFORM control_plane.finalize_answer_artifact(
      current_setting('albert.tenant_id'),
      '30000000-0000-4000-8000-000000000003'::uuid,
      current_setting('test.lineage_conversation_id'),
      '01K2ZZZZZZ0000000000000001','resp_lineage_1',
      '{"requests":1,"inputTokens":20,"outputTokens":10}'::jsonb,'verified',
      'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      '{"rateCardId":"openai-2026.08.03","model":"gpt-5.6-sol","fastMode":false,"requests":1,"inputTokens":20,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":10,"estimatedCostUsdMicros":100,"pricingCompleteness":"request_level"}'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'queryAuditId','01K2ZZZZZZ0000000000000002','route','semantic','topic','sales_performance',
        'bundleHash',repeat('a',64),'registryVersion','2026.08.03',
        'normalizedIr',jsonb_build_object('kind','single','topic','sales_performance','metrics',jsonb_build_array('commerce.net_sales_ex_gst')),
        'compilerOutputHash',repeat('b',64),'resultDigest',repeat('c',64),'answerState','verified',
        'validation',jsonb_build_object('status','passed','checks',jsonb_build_array(
          jsonb_build_object('checkId','no_fanout','status','passed'),
          jsonb_build_object('checkId','grain_compatible_ratios','status','passed'),
          jsonb_build_object('checkId','snapshot_not_summed','status','passed'),
          jsonb_build_object('checkId','authority_respected','status','passed'),
          jsonb_build_object('checkId','golden_fixture_match','status','passed')
        ))
      ))
    );
  EXCEPTION WHEN unique_violation THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'divergent answer artefact replay was accepted'; END IF;
END;
$$;
RESET ROLE;
SELECT pg_temp.assert_true(
  :'replay_answer_artifact_id'=:'finalized_answer_artifact_id'
  AND :'replay_artifact_digest'=:'finalized_artifact_digest'
  AND :'replay_idempotent_replay'='t',
  'an exact retry must return the same content-addressed artefact'
);

SELECT set_config('test.lineage_tenant_id',:'tenant_one_tenant_id',true);
SELECT set_config('test.lineage_artifact_id',:'finalized_answer_artifact_id',true);
DO $$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    UPDATE control_plane.answer_artifacts SET answer_text='tampered'
     WHERE tenant_id=current_setting('test.lineage_tenant_id')
       AND answer_artifact_id=current_setting('test.lineage_artifact_id');
  EXCEPTION WHEN SQLSTATE '55000' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'answer artefact update was not blocked'; END IF;
END;
$$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',true);
SELECT set_config(
  'request.jwt.claims',
  format('{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',:'tenant_one_tenant_id'),
  true
);
SELECT pg_temp.assert_true(
  (public.albert_answer_lineage(:'finalized_answer_artifact_id')->>'artifactDigest')=:'finalized_artifact_digest'
  AND NOT (public.albert_answer_lineage(:'finalized_answer_artifact_id')->'queries'->0 ? 'normalizedIr')
  AND (public.albert_answer_lineage(:'finalized_answer_artifact_id')->'queries'->0 ? 'compilerOutputHash'),
  'safe explanation must expose evidence hashes but not normalized IR or SQL'
);
SELECT pg_temp.assert_true(
  (public.albert_turn_answer_lineage(
    :'begun_conversation_id','01K2ZZZZZZ0000000000000001'
  )->>'answerArtifactId')=:'finalized_answer_artifact_id',
  'a persisted turn identifier must resolve its safe explanation projection'
);
RESET ROLE;

UPDATE control_plane.tenants
   SET status='deleting'
 WHERE tenant_id=:'tenant_one_tenant_id';
SET LOCAL ROLE albert_semantic_control;
SELECT set_config('albert.tenant_id',:'tenant_one_tenant_id',true);
SELECT set_config('test.lineage_conversation_id',:'begun_conversation_id',true);
DO $$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    PERFORM control_plane.finalize_answer_artifact(
      current_setting('albert.tenant_id'),
      '30000000-0000-4000-8000-000000000003'::uuid,
      current_setting('test.lineage_conversation_id'),
      '01K2ZZZZZZ0000000000000001','resp_lineage_1',
      '{"requests":1,"inputTokens":20,"outputTokens":10}'::jsonb,'verified',
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      '{"rateCardId":"openai-2026.08.03","model":"gpt-5.6-sol","fastMode":false,"requests":1,"inputTokens":20,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":10,"estimatedCostUsdMicros":100,"pricingCompleteness":"request_level"}'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'queryAuditId','01K2ZZZZZZ0000000000000002','route','semantic','topic','sales_performance',
        'bundleHash',repeat('a',64),'registryVersion','2026.08.03',
        'normalizedIr',jsonb_build_object('kind','single','topic','sales_performance'),
        'compilerOutputHash',repeat('b',64),'resultDigest',repeat('c',64),'answerState','verified',
        'validation',jsonb_build_object('status','passed')
      ))
    );
  EXCEPTION WHEN SQLSTATE '55000' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'tenant deletion did not fence answer finalization'; END IF;
END;
$$;
RESET ROLE;
UPDATE control_plane.tenants
   SET status='active'
 WHERE tenant_id=:'tenant_one_tenant_id';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','40000000-0000-4000-8000-000000000004',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000004","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant('Lineage Tenant Two','Australia/Melbourne') \gset tenant_two_
SELECT set_config(
  'request.jwt.claims',
  format('{"sub":"40000000-0000-4000-8000-000000000004","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',:'tenant_two_tenant_id'),
  true
);
DO $$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    PERFORM public.albert_answer_lineage(current_setting('test.lineage_artifact_id'));
  EXCEPTION WHEN SQLSTATE 'P0002' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'cross-tenant answer lineage was disclosed'; END IF;
END;
$$;
RESET ROLE;

ROLLBACK;
