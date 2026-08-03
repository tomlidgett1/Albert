\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION '%',message; END IF; END$$;

INSERT INTO auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('30000000-0000-4000-8000-000000000030','authenticated','authenticated','diagnostic-operator@example.com','',now(),'{}','{}',now(),now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO control_plane.internal_operators (user_id,email,reason)
VALUES ('30000000-0000-4000-8000-000000000030','diagnostic-operator@example.com','CI operator diagnostic verification')
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO control_plane.tenants (tenant_id,slug,display_name,status,created_by)
VALUES ('01K1ZZZZZZ0000000000000301','diagnostic-fixture','Diagnostic fixture','active','30000000-0000-4000-8000-000000000030')
ON CONFLICT (tenant_id) DO NOTHING;
INSERT INTO control_plane.pipeline_stats (
  tenant_id,snapshot_at,schema_name,table_name,row_count,invariant_status
) VALUES (
  '01K1ZZZZZZ0000000000000301',now(),'source_xero','invoices',1,'{}'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000030',true);
SELECT set_config('request.jwt.claims','{"sub":"30000000-0000-4000-8000-000000000030","role":"authenticated"}',true);
SELECT public.begin_albert_operator_row_reveal(
  '01K1ZZZZZZ0000000000000302','01K1ZZZZZZ0000000000000301',
  'staging','source_xero','invoices',3
);
RESET ROLE;

-- This transaction validates the underlying one-use grant algorithm as the
-- migration owner. The signed wrapper is exercised separately over a real
-- exact-login connection in control-plane-capability-runtime.sql.
SELECT pg_temp.assert_true(
  control_plane.claim_operator_diagnostic_reveal_pre_capability('01K1ZZZZZZ0000000000000302')->>'table_name'='invoices',
  'diagnostic service must claim the exact pipeline-stats target'
);
DO $$BEGIN
  PERFORM control_plane.claim_operator_diagnostic_reveal_pre_capability('01K1ZZZZZZ0000000000000302');
  RAISE EXCEPTION 'one-use reveal grant was consumed twice';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END$$;
SET LOCAL ROLE albert_operator_diagnostic_control;
SELECT control_plane.complete_operator_diagnostic_reveal(
  '01K1ZZZZZZ0000000000000302','completed',1,NULL
);
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT count(*)=2 FROM control_plane.operator_audit_log
   WHERE actor_user_id='30000000-0000-4000-8000-000000000030'
     AND action LIKE 'operator.row_sample_reveal_%'),
  'request and completed reveal must both be immutable-audited'
);
SELECT pg_temp.assert_true(
  NOT pg_catalog.has_table_privilege('albert_operator_diagnostic_control',
    'control_plane.operator_diagnostic_reveal_requests','SELECT'),
  'diagnostic control role must have no direct table reads'
);

SET LOCAL ROLE authenticated;
DO $$BEGIN
  PERFORM public.begin_albert_operator_row_reveal(
    '01K1ZZZZZZ0000000000000303','01K1ZZZZZZ0000000000000301',
    'canonical','source_xero','invoices',3
  );
  RAISE EXCEPTION 'stage/schema mismatch was accepted';
EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END$$;
DO $$BEGIN
  PERFORM public.begin_albert_operator_row_reveal(
    '01K1ZZZZZZ0000000000000304','01K1ZZZZZZ0000000000000301',
    'staging','source_xero','not_in_pipeline_stats',3
  );
  RAISE EXCEPTION 'non-allowlisted table was accepted';
EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END$$;
RESET ROLE;

-- A completed reveal must not make tenant erasure impossible. Exercise the
-- real deletion lease and purge function, not a privileged direct DELETE.
INSERT INTO control_plane.deletion_requests (
  tenant_id,deletion_request_id,scope,status,requested_by,approved_by,
  approved_at,approval_expires_at,remote_revocation_status,
  credential_destroyed_at,credential_destruction_due_at,purge_due_at,progress
) VALUES (
  '01K1ZZZZZZ0000000000000301','01K1ZZZZZZ0000000000000305','tenant','queued',
  '30000000-0000-4000-8000-000000000030','30000000-0000-4000-8000-000000000030',
  clock_timestamp(),clock_timestamp()+interval '30 minutes','not_applicable',
  clock_timestamp(),clock_timestamp(),clock_timestamp(),'{}'::jsonb
);

-- The victim identity appearing only in a provider-controlled field of an
-- unrelated tenant's message must not satisfy the erasure scope predicate.
SELECT send AS unrelated_queue_message_id
FROM pgmq.send(
  'albert_sync_standard',
  jsonb_build_object(
    'tenantId','01K1ZZZZZZ0000000000000399',
    'connectionId','01K1ZZZZZZ0000000000000398',
    'sourceRecordId','provider-value:01K1ZZZZZZ0000000000000301'
  ),
  0
) \gset diagnostic_unrelated_
SELECT send AS target_queue_message_id
FROM pgmq.send(
  'albert_sync_standard',
  jsonb_build_object(
    'tenantId','01K1ZZZZZZ0000000000000301',
    'connectionId','01K1ZZZZZZ0000000000000306',
    'sourceRecordId','ordinary-value'
  ),
  0
) \gset diagnostic_target_

-- Orphaned messages have their exact queue scope under payload. Exercise both
-- the live and archive dead-letter tables, and preserve unrelated envelopes
-- whose source data happens to mention the victim identity.
SELECT send AS nested_target_q_message_id
FROM pgmq.send(
  'albert_sync_deadletter',
  jsonb_build_object(
    'reason','orphaned_queue_message','sourceQueue','albert_sync_standard',
    'sourceMessageId',9001,
    'payload',jsonb_build_object(
      'tenantId','01K1ZZZZZZ0000000000000301',
      'connectionId','01K1ZZZZZZ0000000000000306'
    )
  ),0
) \gset diagnostic_nested_target_q_
SELECT send AS nested_unrelated_q_message_id
FROM pgmq.send(
  'albert_sync_deadletter',
  jsonb_build_object(
    'reason','orphaned_queue_message','sourceQueue','albert_sync_standard',
    'sourceMessageId',9002,
    'payload',jsonb_build_object(
      'tenantId','01K1ZZZZZZ0000000000000399',
      'connectionId','01K1ZZZZZZ0000000000000398',
      'sourceRecordId','provider-value:01K1ZZZZZZ0000000000000301'
    )
  ),0
) \gset diagnostic_nested_unrelated_q_
SELECT send AS nested_target_a_message_id
FROM pgmq.send(
  'albert_sync_deadletter',
  jsonb_build_object(
    'reason','orphaned_queue_message','sourceQueue','albert_sync_standard',
    'sourceMessageId',9003,
    'payload',jsonb_build_object(
      'tenantId','01K1ZZZZZZ0000000000000301',
      'connectionId','01K1ZZZZZZ0000000000000306'
    )
  ),0
) \gset diagnostic_nested_target_a_
SELECT pg_temp.assert_true(
  pgmq.archive('albert_sync_deadletter',:'diagnostic_nested_target_a_nested_target_a_message_id'::bigint),
  'nested target dead-letter message must be archived for the erasure test'
);
SELECT send AS nested_unrelated_a_message_id
FROM pgmq.send(
  'albert_sync_deadletter',
  jsonb_build_object(
    'reason','orphaned_queue_message','sourceQueue','albert_sync_standard',
    'sourceMessageId',9004,
    'payload',jsonb_build_object(
      'tenantId','01K1ZZZZZZ0000000000000399',
      'connectionId','01K1ZZZZZZ0000000000000398',
      'sourceRecordId','provider-value:01K1ZZZZZZ0000000000000301'
    )
  ),0
) \gset diagnostic_nested_unrelated_a_
SELECT pg_temp.assert_true(
  pgmq.archive('albert_sync_deadletter',:'diagnostic_nested_unrelated_a_nested_unrelated_a_message_id'::bigint),
  'nested unrelated dead-letter message must be archived for the erasure test'
);

SELECT control_plane.enqueue_deletion_request(
  '01K1ZZZZZZ0000000000000305'
) AS deletion_queue_message_id \gset diagnostic_deletion_
SELECT message_id,read_count
FROM control_plane.claim_deletion_jobs('operator-diagnostic-erasure-test',900,1)
WHERE payload->>'deletionRequestId'='01K1ZZZZZZ0000000000000305'
\gset diagnostic_claim_

SELECT control_plane.purge_tenant_control(
  :'diagnostic_claim_message_id'::bigint,
  '01K1ZZZZZZ0000000000000305',
  'operator-diagnostic-erasure-test',
  :'diagnostic_claim_read_count'::integer
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM control_plane.operator_diagnostic_reveal_requests
    WHERE tenant_id='01K1ZZZZZZ0000000000000301'
  )
  AND NOT EXISTS (
    SELECT 1 FROM control_plane.operator_diagnostic_reveal_claims
    WHERE reveal_id='01K1ZZZZZZ0000000000000302'
  )
  AND NOT EXISTS (
    SELECT 1 FROM control_plane.operator_diagnostic_reveal_outcomes
    WHERE reveal_id='01K1ZZZZZZ0000000000000302'
  ),
  'tenant purge must erase reveal outcomes, claims, then requests'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pgmq.q_albert_sync_standard
    WHERE msg_id=:'diagnostic_target_target_queue_message_id'::bigint
  ),
  'tenant purge must remove the exact tenant queue message'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM pgmq.q_albert_sync_standard
    WHERE msg_id=:'diagnostic_unrelated_unrelated_queue_message_id'::bigint
  ),
  'tenant purge must preserve another tenant message containing the victim ULID only in source data'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pgmq.q_albert_sync_deadletter
    WHERE msg_id=:'diagnostic_nested_target_q_nested_target_q_message_id'::bigint
  )
  AND NOT EXISTS (
    SELECT 1 FROM pgmq.a_albert_sync_deadletter
    WHERE msg_id=:'diagnostic_nested_target_a_nested_target_a_message_id'::bigint
  ),
  'tenant purge must erase nested-scope orphan envelopes from live and archived dead-letter queues'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM pgmq.q_albert_sync_deadletter
    WHERE msg_id=:'diagnostic_nested_unrelated_q_nested_unrelated_q_message_id'::bigint
  )
  AND EXISTS (
    SELECT 1 FROM pgmq.a_albert_sync_deadletter
    WHERE msg_id=:'diagnostic_nested_unrelated_a_nested_unrelated_a_message_id'::bigint
  ),
  'tenant purge must preserve unrelated nested envelopes mentioning the victim only in source data'
);
SELECT pg_temp.assert_true(
  (control_plane.verify_claimed_control_deletion(
    :'diagnostic_claim_message_id'::bigint,
    '01K1ZZZZZZ0000000000000305',
    'operator-diagnostic-erasure-test',
    :'diagnostic_claim_read_count'::integer
  )->>'verified')::boolean,
  'control-plane tenant erasure verification must pass after reveal removal'
);

ROLLBACK;
