\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'clarification-confirmation assertion failed: %',message;
  END IF;
END;
$$;

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '51000000-0000-4000-8000-000000000005','authenticated','authenticated',
  'clarification-owner@albert.invalid','',now(),'{}','{}',now(),now()
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000005',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"51000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant(
  'Clarification Confirmation Tenant','Australia/Melbourne'
) \gset tenant_
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"51000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'tenant_tenant_id'
  ),
  true
);
SELECT * FROM public.begin_albert_turn(
  NULL,'01K3AAAAAAAAAAAAAAAAAAAAAA',
  'Who performed best?',
  '{"model":"gpt-5.6-sol","reasoningEffort":"medium","fastMode":false,"runtime":"openai-agents-sdk"}'::jsonb
) \gset clarification_
SELECT public.albert_answer_event_append(
  :'clarification_conversation_id','01K3AAAAAAAAAAAAAAAAAAAAAA',
  '{"id":"clarification-1","sequence":1,"occurredAt":"2026-08-03T02:00:00Z","type":"clarification","status":"complete","question":"Which performance lens should I use?","options":[{"id":"employee.net_sales","label":"Net sales"},{"id":"employee.gross_margin","label":"Gross profit"}]}'::jsonb
);
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT count(*)=1
     FROM control_plane.clarification_prompts
    WHERE tenant_id=:'tenant_tenant_id'
      AND offered_turn_id='01K3AAAAAAAAAAAAAAAAAAAAAA')
  AND
  (SELECT count(*)=2
     FROM control_plane.clarification_options
    WHERE tenant_id=:'tenant_tenant_id'
      AND offered_turn_id='01K3AAAAAAAAAAAAAAAAAAAAAA'),
  'a persisted clarification event must create one prompt and its canonical options'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated','control_plane.clarification_options','SELECT')
  AND NOT has_table_privilege('authenticated','control_plane.preference_value_allowlist','SELECT'),
  'the browser must not read or mutate server-owned confirmation bindings'
);

SET LOCAL ROLE albert_semantic_control;
SELECT set_config('albert.tenant_id',:'tenant_tenant_id',true);
SELECT * FROM control_plane.finalize_answer_artifact(
  :'tenant_tenant_id','51000000-0000-4000-8000-000000000005'::uuid,
  :'clarification_conversation_id','01K3AAAAAAAAAAAAAAAAAAAAAA',
  'resp_clarification_1','{"requests":1,"inputTokens":10,"outputTokens":5}'::jsonb,
  'clarification','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '{"rateCardId":"openai-2026.08.03","model":"gpt-5.6-sol","fastMode":false,"requests":1,"inputTokens":10,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":5,"estimatedCostUsdMicros":50,"pricingCompleteness":"request_level"}'::jsonb,
  '[]'::jsonb
) \gset finalized_
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000005',true);
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"51000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'tenant_tenant_id'
  ),
  true
);
SELECT * FROM public.begin_albert_turn(
  :'clarification_conversation_id','01K3BBBBBBBBBBBBBBBBBBBBBB',
  'Net sales',
  '{"model":"gpt-5.6-sol","reasoningEffort":"medium","fastMode":false,"runtime":"openai-agents-sdk"}'::jsonb,
  '01K3AAAAAAAAAAAAAAAAAAAAAA','employee.net_sales'
) \gset confirmed_
SELECT pg_temp.assert_true(
  :'confirmed_confirmed_option_id'='employee.net_sales'
  AND :'confirmed_confirmed_preference'='employee.performance_default'
  AND :'confirmed_confirmed_value'='commerce.net_sales_ex_gst',
  'begin must resolve the exact server-owned key/value rather than a browser value'
);

-- An exact retry returns the same consumed receipt; a changed option does not.
SELECT * FROM public.begin_albert_turn(
  :'clarification_conversation_id','01K3BBBBBBBBBBBBBBBBBBBBBB',
  'Net sales',
  '{"model":"gpt-5.6-sol","reasoningEffort":"medium","fastMode":false,"runtime":"openai-agents-sdk"}'::jsonb,
  '01K3AAAAAAAAAAAAAAAAAAAAAA','employee.net_sales'
) \gset retry_
SELECT pg_temp.assert_true(
  :'retry_confirmed_preference'=:'confirmed_confirmed_preference'
  AND :'retry_confirmed_value'=:'confirmed_confirmed_value',
  'an exact request retry must return the same receipt idempotently'
);
SELECT set_config('test.confirmation_conversation_id',:'clarification_conversation_id',true);
SELECT set_config('test.confirmation_tenant_id',:'tenant_tenant_id',true);
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.begin_albert_turn(
      current_setting('test.confirmation_conversation_id'),'01K3BBBBBBBBBBBBBBBBBBBBBB',
      'Net sales',
      '{"model":"gpt-5.6-sol","reasoningEffort":"medium","fastMode":false,"runtime":"openai-agents-sdk"}'::jsonb,
      '01K3AAAAAAAAAAAAAAAAAAAAAA','employee.gross_margin'
    );
    RAISE EXCEPTION 'a changed confirmation replay was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;
SELECT public.fail_albert_turn(
  :'clarification_conversation_id','01K3BBBBBBBBBBBBBBBBBBBBBB','confirmation_test_complete'
);

DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.begin_albert_turn(
      current_setting('test.confirmation_conversation_id'),'01K3CCCCCCCCCCCCCCCCCCCCCC',
      'Net sales',
      '{"model":"gpt-5.6-sol","reasoningEffort":"medium","fastMode":false,"runtime":"openai-agents-sdk"}'::jsonb,
      '01K3AAAAAAAAAAAAAAAAAAAAAA','employee.net_sales'
    );
    RAISE EXCEPTION 'a consumed option was replayed into a second turn';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.begin_albert_turn(
      current_setting('test.confirmation_conversation_id'),'01K3DDDDDDDDDDDDDDDDDDDDDD',
      'Gross profit',
      '{"model":"gpt-5.6-sol","reasoningEffort":"medium","fastMode":false,"runtime":"openai-agents-sdk"}'::jsonb,
      '01K3AAAAAAAAAAAAAAAAAAAAAA','employee.gross_margin'
    );
    RAISE EXCEPTION 'a sibling option from a consumed prompt was accepted';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.begin_albert_turn(
      current_setting('test.confirmation_conversation_id'),'01K3EEEEEEEEEEEEEEEEEEEEEE',
      'Tampered option',
      '{"model":"gpt-5.6-sol","reasoningEffort":"medium","fastMode":false,"runtime":"openai-agents-sdk"}'::jsonb,
      '01K3AAAAAAAAAAAAAAAAAAAAAA','employee.sales_per_labour_hour'
    );
    RAISE EXCEPTION 'an option not offered by the prior turn was accepted';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END;
$$;

-- A browser cannot introduce a new preference key/value through any overlay
-- writer because the table-level trigger is the final enforcement boundary.
RESET ROLE;
DO $$
BEGIN
  BEGIN
    UPDATE control_plane.tenant_overlays
       SET overlay=jsonb_set(
         overlay||jsonb_build_object(
           'remembered_preferences',coalesce(overlay->'remembered_preferences','{}'::jsonb)
         ),
         ARRAY['remembered_preferences','arbitrary.preference'],
         '"tampered"'::jsonb,
         true
       )
     WHERE tenant_id=current_setting('test.confirmation_tenant_id') AND status='published';
    RAISE EXCEPTION 'a non-allowlisted preference reached the tenant overlay';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$$;

SELECT pg_temp.assert_true(
  (SELECT prompt.consumed_turn_id='01K3BBBBBBBBBBBBBBBBBBBBBB'
       AND prompt.consumed_option_id='employee.net_sales'
       AND prompt.consumed_at IS NOT NULL
       AND option.preference_key='employee.performance_default'
       AND option.preference_value='commerce.net_sales_ex_gst'
     FROM control_plane.clarification_prompts AS prompt
     JOIN control_plane.clarification_options AS option
       ON option.tenant_id=prompt.tenant_id
      AND option.offered_turn_id=prompt.offered_turn_id
      AND option.option_id=prompt.consumed_option_id
    WHERE prompt.tenant_id=:'tenant_tenant_id'
      AND prompt.offered_turn_id='01K3AAAAAAAAAAAAAAAAAAAAAA'),
  'the chosen option must be consumed exactly once by its bound follow-on turn'
);

ROLLBACK;
