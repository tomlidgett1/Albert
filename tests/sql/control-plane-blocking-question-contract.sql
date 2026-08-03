\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'blocking-question contract assertion failed: %', message;
  END IF;
END;
$$;

SELECT pg_temp.assert_true(
  (
    SELECT contract_digest = encode(
      extensions.digest(convert_to(contract_canonical_json, 'UTF8'), 'sha256'),
      'hex'
    )
      AND contract_version = contract_canonical_json::jsonb ->> 'contractVersion'
      AND jsonb_array_length(contract_canonical_json::jsonb -> 'questions') = 4
      AND (
        SELECT sum(jsonb_array_length(question_item -> 'options'))
        FROM jsonb_array_elements(
          contract_canonical_json::jsonb -> 'questions'
        ) AS question_row(question_item)
      ) = 11
    FROM control_plane.blocking_question_contract
    WHERE singleton
  ),
  'the singleton must bind the exact version, digest, four questions, and eleven options'
);

SELECT pg_temp.assert_true(
  (SELECT relrowsecurity
   FROM pg_class
   WHERE oid = 'control_plane.blocking_question_contract'::regclass)
  AND NOT has_table_privilege(
    'authenticated',
    'control_plane.blocking_question_contract',
    'SELECT'
  )
  AND NOT has_table_privilege(
    'service_role',
    'control_plane.blocking_question_contract',
    'SELECT'
  )
  AND has_function_privilege(
    'authenticated',
    'public.albert_answer_blocking_question(text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'public.albert_answer_blocking_question(text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'service_role',
    'public.albert_answer_blocking_question(text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'albert_sync_control',
    'public.albert_answer_blocking_question(text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'albert_webhook_control',
    'public.albert_answer_blocking_question(text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'albert_transform_control',
    'public.albert_answer_blocking_question(text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'albert_semantic_control',
    'public.albert_answer_blocking_question(text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'albert_operator_diagnostic_control',
    'public.albert_answer_blocking_question(text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'albert_deletion_control',
    'public.albert_answer_blocking_question(text,text)',
    'EXECUTE'
  ),
  'only the authenticated RPC may cross the private contract boundary'
);

DO $$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    UPDATE control_plane.blocking_question_contract
    SET installed_at = installed_at;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    blocked := true;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'the installed contract accepted an update';
  END IF;
END;
$$;

INSERT INTO auth.users(
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) VALUES (
  '66000000-0000-4000-8000-000000000066',
  'authenticated',
  'authenticated',
  'blocking-question-contract@albert.invalid',
  '',
  now(),
  '{}',
  '{}',
  now(),
  now()
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  '66000000-0000-4000-8000-000000000066',
  true
);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"66000000-0000-4000-8000-000000000066","role":"authenticated","app_metadata":{}}',
  true
);
SELECT *
FROM public.bootstrap_albert_tenant(
  'Blocking Question Contract Tenant',
  'Australia/Melbourne'
) \gset blocking_question_
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"66000000-0000-4000-8000-000000000066","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'blocking_question_tenant_id'
  ),
  true
);
SELECT set_config(
  'test.blocking_question_tenant_id',
  :'blocking_question_tenant_id',
  true
);

RESET ROLE;
SET LOCAL ROLE service_role;
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"66000000-0000-4000-8000-000000000066","role":"service_role","app_metadata":{"active_tenant_id":"%s"}}',
    :'blocking_question_tenant_id'
  ),
  true
);
DO $$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    PERFORM public.albert_answer_blocking_question('sales-lens', 'ex-gst');
  EXCEPTION WHEN insufficient_privilege THEN
    blocked := true;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'service_role used a forged owner claim to answer a question';
  END IF;
END;
$$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    PERFORM public.albert_answer_blocking_question('sales-lens', 'ex-gst');
  EXCEPTION WHEN insufficient_privilege THEN
    blocked := SQLERRM = 'authenticated owner or manager role required';
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'a non-authenticated JWT role used a forged owner claim';
  END IF;
END;
$$;
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"66000000-0000-4000-8000-000000000066","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'blocking_question_tenant_id'
  ),
  true
);

DO $$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    PERFORM public.albert_answer_blocking_question('sales-lens', 'unreviewed-option');
  EXCEPTION WHEN SQLSTATE '22023' THEN
    blocked := SQLERRM = 'blocking question option is not allowlisted';
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'an option absent from the immutable contract was accepted';
  END IF;
END;
$$;

DO $$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    PERFORM public.albert_answer_blocking_question('sales-lens', 'ex-gst');
  EXCEPTION WHEN SQLSTATE '22023' THEN
    blocked := SQLERRM = 'blocking question connector prerequisites are not satisfied';
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'a question without its connector prerequisite was accepted';
  END IF;
END;
$$;
RESET ROLE;

SELECT control_plane.generate_ulid() AS lightspeed_connection_id \gset
INSERT INTO control_plane.connections(
  tenant_id,
  connection_id,
  connector_key,
  display_name,
  status,
  auth_health,
  authorised_by,
  authorised_at
) VALUES (
  :'blocking_question_tenant_id',
  :'lightspeed_connection_id',
  'lightspeed-r',
  'Blocking Question Lightspeed',
  'pending',
  'unknown',
  '66000000-0000-4000-8000-000000000066',
  now()
);

SET LOCAL ROLE authenticated;
DO $$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    PERFORM public.albert_answer_blocking_question('sales-lens', 'ex-gst');
  EXCEPTION WHEN SQLSTATE '22023' THEN
    blocked := SQLERRM = 'blocking question connector prerequisites are not satisfied';
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'a pending connector incorrectly satisfied a prerequisite';
  END IF;
END;
$$;
RESET ROLE;

UPDATE control_plane.connections
SET status = 'connected', auth_health = 'healthy'
WHERE tenant_id = :'blocking_question_tenant_id'
  AND connection_id = :'lightspeed_connection_id';

CREATE OR REPLACE FUNCTION pg_temp.assert_overlay(
  path text[],
  expected text,
  message text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual text;
BEGIN
  SELECT overlay #>> path
  INTO actual
  FROM control_plane.tenant_overlays
  WHERE tenant_id = current_setting('test.blocking_question_tenant_id')
    AND status = 'published';
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'blocking-question overlay assertion failed: % (expected %, observed %)',
      message, expected, actual;
  END IF;
END;
$$;

SET LOCAL ROLE authenticated;
SELECT public.albert_answer_blocking_question('sales-lens', 'ex-gst');
RESET ROLE;
SELECT pg_temp.assert_overlay(ARRAY['tax_display_default'], 'exclusive', 'ex-GST tax display');
SELECT pg_temp.assert_overlay(
  ARRAY['remembered_preferences', 'sales.default_metric'],
  'commerce.net_sales_ex_gst',
  'ex-GST sales metric'
);

SET LOCAL ROLE authenticated;
SELECT public.albert_answer_blocking_question('sales-lens', 'inc-gst');
RESET ROLE;
SELECT pg_temp.assert_overlay(ARRAY['tax_display_default'], 'inclusive', 'inc-GST tax display');
SELECT pg_temp.assert_overlay(
  ARRAY['remembered_preferences', 'sales.default_metric'],
  'commerce.gross_takings_inc_gst',
  'inc-GST sales metric'
);

SET LOCAL ROLE authenticated;
SELECT public.albert_answer_blocking_question('trading-day', 'midnight');
RESET ROLE;
SELECT pg_temp.assert_overlay(ARRAY['trading_day_cutoff'], '00:00', 'midnight cutoff');
SET LOCAL ROLE authenticated;
SELECT public.albert_answer_blocking_question('trading-day', '2am');
RESET ROLE;
SELECT pg_temp.assert_overlay(ARRAY['trading_day_cutoff'], '02:00', '2 am cutoff');
SET LOCAL ROLE authenticated;
SELECT public.albert_answer_blocking_question('trading-day', '4am');
RESET ROLE;
SELECT pg_temp.assert_overlay(ARRAY['trading_day_cutoff'], '04:00', '4 am cutoff');

SET LOCAL ROLE authenticated;
DO $$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    PERFORM public.albert_answer_blocking_question('employee-performance', 'net-sales');
  EXCEPTION WHEN SQLSTATE '22023' THEN
    blocked := SQLERRM = 'blocking question connector prerequisites are not satisfied';
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'employee performance was accepted without Deputy';
  END IF;
END;
$$;
RESET ROLE;

INSERT INTO control_plane.connections(
  tenant_id,
  connection_id,
  connector_key,
  display_name,
  status,
  auth_health,
  authorised_by,
  authorised_at
) VALUES (
  :'blocking_question_tenant_id',
  control_plane.generate_ulid(),
  'deputy',
  'Blocking Question Deputy',
  'connected',
  'healthy',
  '66000000-0000-4000-8000-000000000066',
  now()
);

SET LOCAL ROLE authenticated;
SELECT public.albert_answer_blocking_question('employee-performance', 'net-sales');
RESET ROLE;
SELECT pg_temp.assert_overlay(
  ARRAY['remembered_preferences', 'employee.performance_default'],
  'commerce.net_sales_ex_gst',
  'employee net-sales default'
);
SET LOCAL ROLE authenticated;
SELECT public.albert_answer_blocking_question('employee-performance', 'gross-profit');
RESET ROLE;
SELECT pg_temp.assert_overlay(
  ARRAY['remembered_preferences', 'employee.performance_default'],
  'commerce.gross_margin',
  'employee gross-profit default'
);
SET LOCAL ROLE authenticated;
SELECT public.albert_answer_blocking_question('employee-performance', 'profit-per-hour');
RESET ROLE;
SELECT pg_temp.assert_overlay(
  ARRAY['remembered_preferences', 'employee.performance_default'],
  'composites.gross_profit_per_labour_hour',
  'employee gross-profit-per-hour default'
);

SET LOCAL ROLE authenticated;
DO $$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    PERFORM public.albert_answer_blocking_question('pos-posting-topology', 'daily-summary');
  EXCEPTION WHEN SQLSTATE '22023' THEN
    blocked := SQLERRM = 'blocking question connector prerequisites are not satisfied';
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'posting topology was accepted without Xero';
  END IF;
END;
$$;
RESET ROLE;

INSERT INTO control_plane.connections(
  tenant_id,
  connection_id,
  connector_key,
  display_name,
  status,
  auth_health,
  authorised_by,
  authorised_at
) VALUES (
  :'blocking_question_tenant_id',
  control_plane.generate_ulid(),
  'xero',
  'Blocking Question Xero',
  'connected',
  'healthy',
  '66000000-0000-4000-8000-000000000066',
  now()
);

SET LOCAL ROLE authenticated;
SELECT public.albert_answer_blocking_question('pos-posting-topology', 'daily-summary');
RESET ROLE;
SELECT pg_temp.assert_overlay(
  ARRAY['remembered_preferences', 'reconciliation.pos_posting_topology'],
  'daily_summary_journals',
  'daily-summary posting topology'
);
SET LOCAL ROLE authenticated;
SELECT public.albert_answer_blocking_question('pos-posting-topology', 'line-by-line');
RESET ROLE;
SELECT pg_temp.assert_overlay(
  ARRAY['remembered_preferences', 'reconciliation.pos_posting_topology'],
  'individual_transactions',
  'line-by-line posting topology'
);
SET LOCAL ROLE authenticated;
SELECT public.albert_answer_blocking_question('pos-posting-topology', 'not-sure');
RESET ROLE;
SELECT pg_temp.assert_overlay(
  ARRAY['remembered_preferences', 'reconciliation.pos_posting_topology'],
  'unknown',
  'unknown posting topology'
);

SELECT count(*) AS before_idempotent_count
FROM control_plane.tenant_overlays
WHERE tenant_id = :'blocking_question_tenant_id' \gset blocking_question_
SET LOCAL ROLE authenticated;
SELECT public.albert_answer_blocking_question('pos-posting-topology', 'not-sure');
RESET ROLE;
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = :'blocking_question_before_idempotent_count'::bigint
    FROM control_plane.tenant_overlays
    WHERE tenant_id = :'blocking_question_tenant_id'
  ),
  'an exact repeated answer must be idempotent'
);

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 11
      AND bool_and(
        audit_metadata ->> 'contract_version' = 'albert-blocking-questions/1'
        AND audit_metadata ->> 'contract_digest' =
          'cbdd710ed6fae8bd811d646b00e5ae27345270d1a3375bcabb55ed9dc3796723'
      )
    FROM control_plane.audit_log
    WHERE tenant_id = :'blocking_question_tenant_id'
      AND action = 'onboarding.blocking_question_answered'
  ),
  'every operative answer must preserve immutable contract lineage in audit'
);

ROLLBACK;
