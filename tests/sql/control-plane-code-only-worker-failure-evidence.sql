BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(condition boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION '%',message; END IF;
END;
$$;

SELECT pg_temp.assert_true(
  has_function_privilege(
    'albert_sync_control',
    'control_plane.retry_or_fail_sync_job(text,bigint,text,text,integer,jsonb,integer,integer)',
    'EXECUTE'
  ),
  'the sync role must retain the validated retry transition'
);
SELECT pg_temp.assert_true(
  has_function_privilege(
    'albert_transform_control',
    'control_plane.retry_or_fail_canonical_transform_job(text,text,text,text,jsonb,integer,integer)',
    'EXECUTE'
  ),
  'the transform role must retain the validated retry transition'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege(
    'albert_sync_control',
    'control_plane.retry_or_fail_sync_job_unvalidated_0058(text,bigint,text,text,integer,jsonb,integer,integer)',
    'EXECUTE'
  ) AND NOT has_function_privilege(
    'albert_sync_control',
    'control_plane.defer_sync_job_unvalidated_0058(text,bigint,text,text,integer,jsonb,integer)',
    'EXECUTE'
  ) AND NOT has_function_privilege(
    'albert_sync_control',
    'control_plane.block_reconciliation_phase_unvalidated_0058(text,text,bigint,text,text,text,jsonb,text,text,bigint,text,integer)',
    'EXECUTE'
  ) AND NOT has_function_privilege(
    'albert_sync_control',
    'control_plane.mark_stream_phase_unavailable_unvalidated_0058(text,text,bigint,text,text,integer,jsonb)',
    'EXECUTE'
  ) AND NOT has_function_privilege(
    'albert_transform_control',
    'control_plane.retry_or_fail_transform_job_unvalidated_0058(text,text,text,text,jsonb,integer,integer)',
    'EXECUTE'
  ) AND NOT has_function_privilege(
    'albert_transform_control',
    'control_plane.fail_identity_projection_unvalidated_0058(text,text,text,text,jsonb,integer,integer)',
    'EXECUTE'
  ) AND NOT has_function_privilege(
    'anon',
    'control_plane.worker_failure_document_has_exact_keys_0058(jsonb,text[])',
    'EXECUTE'
  ),
  'private implementations and validators must remain default-deny'
);

DO $$
BEGIN
  BEGIN
    PERFORM control_plane.retry_or_fail_sync_job(
      'albert_sync_standard',1,'01H00000000000000000000901','failure-test',1,
      '{"code":"rate_limited","retryable":true,"detail":"Bearer secret@example.com"}',
      1,8
    );
    RAISE EXCEPTION 'sync retry accepted free-text failure evidence';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.retry_or_fail_sync_job(
      'albert_sync_standard',1,'01H00000000000000000000901','failure-test',1,
      '{"code":"attacker_chosen_code","retryable":true}',1,8
    );
    RAISE EXCEPTION 'sync retry accepted an unknown failure code';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.defer_sync_job(
      'albert_sync_standard',1,'01H00000000000000000000901','failure-test',1,
      '{"code":"rate_limited","detail":"source text"}',1
    );
    RAISE EXCEPTION 'sync deferral accepted an extra evidence key';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.block_reconciliation_phase(
      '01H00000000000000000000902','01H00000000000000000000903',1,
      '01H00000000000000000000904','sales','late_edits',
      '{"code":"arbitrary_reconciliation_text","retryable":false}',
      '01H00000000000000000000901','albert_sync_standard',1,'failure-test',1
    );
    RAISE EXCEPTION 'reconciliation block accepted an unknown failure code';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.block_reconciliation_phase(
      '01H00000000000000000000902','01H00000000000000000000903',1,
      '01H00000000000000000000904','sales','late_edits',
      '{"code":"reconciliation_snapshot_failed","retryable":false,"attempt":"1"}',
      '01H00000000000000000000901','albert_sync_standard',1,'failure-test',1
    );
    RAISE EXCEPTION 'reconciliation block accepted a non-numeric attempt';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.retry_or_fail_canonical_transform_job(
      '01H00000000000000000000902','01H00000000000000000000905',
      'failure-test','01H00000000000000000000906',
      '{"code":"canonical_mapping_version_mismatch","retryable":false,"detail":"source PII"}',
      1,12
    );
    RAISE EXCEPTION 'canonical retry accepted free-text failure evidence';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.retry_or_fail_canonical_transform_job(
      '01H00000000000000000000902','01H00000000000000000000905',
      'failure-test','01H00000000000000000000906',
      '{"code":"canonical_attacker_chosen","retryable":false}',1,12
    );
    RAISE EXCEPTION 'canonical retry accepted an unknown failure code';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.fail_identity_decision_projection(
      '01H00000000000000000000902','01H00000000000000000000907',
      'failure-test','01H00000000000000000000908',
      '{"code":"unexpected_identity_projection_failure","retryable":true,"detail":"customer@example.com"}',
      1,12
    );
    RAISE EXCEPTION 'identity retry accepted free-text failure evidence';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.fail_identity_decision_projection(
      '01H00000000000000000000902','01H00000000000000000000907',
      'failure-test','01H00000000000000000000908',
      '{"code":"identity_projection_attacker_chosen","retryable":true}',1,12
    );
    RAISE EXCEPTION 'identity retry accepted an unknown failure code';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.mark_sync_stream_phase_unavailable(
      '01H00000000000000000000902','01H00000000000000000000903',1,
      'journals','recent',1,
      '{"code":"capability_unavailable","retryable":false,"detail":"Advanced tier"}'
    );
    RAISE EXCEPTION 'optional unavailable transition accepted free text';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$$;

-- Exact valid documents must pass the wrappers and reach the unchanged lease
-- implementations. These synthetic identities therefore fail as stale (55000),
-- never as malformed evidence (22023).
DO $$
BEGIN
  BEGIN
    PERFORM control_plane.retry_or_fail_sync_job(
      'albert_sync_standard',1,'01H00000000000000000000901','failure-test',1,
      '{"code":"database_unavailable","retryable":true}',1,8
    );
    RAISE EXCEPTION 'synthetic sync lease unexpectedly existed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.defer_sync_job(
      'albert_sync_standard',1,'01H00000000000000000000901','failure-test',1,
      '{"code":"rate_limited"}',1
    );
    RAISE EXCEPTION 'synthetic sync deferral lease unexpectedly existed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.block_reconciliation_phase(
      '01H00000000000000000000902','01H00000000000000000000903',1,
      '01H00000000000000000000904','sales','late_edits',
      '{"code":"reconciliation_snapshot_failed","retryable":false,"attempt":8}',
      '01H00000000000000000000901','albert_sync_standard',1,'failure-test',1
    );
    RAISE EXCEPTION 'synthetic reconciliation lease unexpectedly existed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.retry_or_fail_canonical_transform_job(
      '01H00000000000000000000902','01H00000000000000000000905',
      'failure-test','01H00000000000000000000906',
      '{"code":"canonical_mapping_version_mismatch","retryable":false}',1,12
    );
    RAISE EXCEPTION 'synthetic canonical transform lease unexpectedly existed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.fail_identity_decision_projection(
      '01H00000000000000000000902','01H00000000000000000000907',
      'failure-test','01H00000000000000000000908',
      '{"code":"unexpected_identity_projection_failure","retryable":true}',1,12
    );
    RAISE EXCEPTION 'synthetic identity projection lease unexpectedly existed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    PERFORM control_plane.mark_sync_stream_phase_unavailable(
      '01H00000000000000000000902','01H00000000000000000000903',1,
      'journals','recent',1,
      '{"code":"capability_unavailable","retryable":false}'
    );
    RAISE EXCEPTION 'synthetic optional stream phase unexpectedly existed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END;
$$;

ROLLBACK;
