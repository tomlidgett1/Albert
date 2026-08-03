\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'owner concurrency assertion failed: %', message;
  END IF;
END;
$$;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('61000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated',
   'owner-race-a@albert.invalid', '', now(), '{}', '{}', now(), now()),
  ('62000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated',
   'owner-race-b@albert.invalid', '', now(), '{}', '{}', now(), now());

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000006', true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{}}',
  true
);
SELECT *
  FROM public.bootstrap_albert_tenant('Owner Race', 'Australia/Sydney')
  \gset owner_race_
SELECT public.albert_add_organisation_member(
  :'owner_race_tenant_id','owner-race-b@albert.invalid','owner'
);
COMMIT;

-- The helper keeps an expected authorization failure inside the remote
-- transaction so the harness can inspect it without making psql ignore errors.
CREATE OR REPLACE FUNCTION public.albert_test_owner_race_update(
  p_expected_tenant_id text,
  p_user_id uuid,
  p_role text
)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.albert_update_organisation_member(
    p_expected_tenant_id,p_user_id,p_role,'active'
  );
  RETURN 'updated';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END;
$$;
REVOKE ALL ON FUNCTION public.albert_test_owner_race_update(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_test_owner_race_update(text,uuid,text) TO authenticated;

SELECT extensions.dblink_connect(
  'albert_owner_race_a',
  format(
    'host=supabase_db_albert-ci port=%s dbname=%L user=postgres password=postgres require_auth=scram-sha-256',
    current_setting('port'),
    current_database()
  )
);
SELECT extensions.dblink_connect(
  'albert_owner_race_b',
  format(
    'host=supabase_db_albert-ci port=%s dbname=%L user=postgres password=postgres require_auth=scram-sha-256',
    current_setting('port'),
    current_database()
  )
);

SELECT extensions.dblink_exec('albert_owner_race_a', 'BEGIN');
SELECT extensions.dblink_exec('albert_owner_race_a', 'SET LOCAL ROLE authenticated');
SELECT * FROM extensions.dblink(
  'albert_owner_race_a',
  format(
    $remote$
      SELECT set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000006', true),
             set_config(
               'request.jwt.claims',
               %L,
               true
             )
    $remote$,
    format(
      '{"sub":"61000000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
      :'owner_race_tenant_id'
    )
  )
) AS configured(subject text, claims text);
SELECT pg_temp.assert_true(
  (SELECT outcome = 'updated'
     FROM extensions.dblink(
       'albert_owner_race_a',
       format($remote$
         SELECT public.albert_test_owner_race_update(%L,
           '62000000-0000-4000-8000-000000000006',
           'manager'
         )
       $remote$, :'owner_race_tenant_id')
     ) AS result(outcome text)),
  'the first owner transition must succeed while retaining its tenant lock'
);

SELECT extensions.dblink_exec('albert_owner_race_b', 'BEGIN');
SELECT extensions.dblink_exec('albert_owner_race_b', 'SET LOCAL ROLE authenticated');
SELECT * FROM extensions.dblink(
  'albert_owner_race_b',
  format(
    $remote$
      SELECT set_config('request.jwt.claim.sub', '62000000-0000-4000-8000-000000000006', true),
             set_config(
               'request.jwt.claims',
               %L,
               true
             )
    $remote$,
    format(
      '{"sub":"62000000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
      :'owner_race_tenant_id'
    )
  )
) AS configured(subject text, claims text);
SELECT pg_temp.assert_true(
  extensions.dblink_send_query(
    'albert_owner_race_b',
    format($remote$
      SELECT public.albert_test_owner_race_update(%L,
        '61000000-0000-4000-8000-000000000006',
        'manager'
      )
    $remote$, :'owner_race_tenant_id')
  ) = 1,
  'the competing demotion must be dispatched asynchronously'
);
SELECT pg_temp.assert_true(
  extensions.dblink_is_busy('albert_owner_race_b') = 1,
  'the competing owner transition must wait on the tenant roster lock'
);

SELECT extensions.dblink_exec('albert_owner_race_a', 'COMMIT');
SELECT pg_temp.assert_true(
  (SELECT outcome = '42501'
     FROM extensions.dblink_get_result('albert_owner_race_b') AS result(outcome text)),
  'the former owner must fail the post-lock authorization recheck'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0
     FROM extensions.dblink_get_result('albert_owner_race_b') AS drained(outcome text)),
  'the asynchronous owner transition result must be fully drained'
);
SELECT extensions.dblink_exec('albert_owner_race_b', 'COMMIT');

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1
     FROM control_plane.memberships
    WHERE tenant_id = :'owner_race_tenant_id'
      AND role = 'owner'
      AND status = 'active'),
  'concurrent cross-demotions must leave exactly one active owner'
);

SELECT extensions.dblink_disconnect('albert_owner_race_a');
SELECT extensions.dblink_disconnect('albert_owner_race_b');
DROP FUNCTION public.albert_test_owner_race_update(text,uuid,text);

BEGIN;
SET LOCAL ROLE albert_control_migration_owner;
SET LOCAL albert.deletion_authorized = 'on';
DELETE FROM control_plane.audit_log
 WHERE tenant_id = :'owner_race_tenant_id';
DELETE FROM control_plane.tenants
 WHERE tenant_id = :'owner_race_tenant_id';
COMMIT;
DELETE FROM auth.users
 WHERE id IN (
   '61000000-0000-4000-8000-000000000006',
   '62000000-0000-4000-8000-000000000006'
 );
