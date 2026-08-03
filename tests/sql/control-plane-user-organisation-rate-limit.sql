\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'user organisation rate-limit assertion failed: %',message;
  END IF;
END;
$$;

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES
  (
    '6f000000-0000-4000-8000-000000000001','authenticated','authenticated',
    'creation-limit-a@albert.invalid','',now(),'{}','{}',now(),now()
  ),
  (
    '6f000000-0000-4000-8000-000000000002','authenticated','authenticated',
    'creation-limit-b@albert.invalid','',now(),'{}','{}',now(),now()
  );

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub','6f000000-0000-4000-8000-000000000001',true
);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"6f000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant(
  'Creation Limit Root','Australia/Melbourne'
);
DO $$
DECLARE iteration integer;
BEGIN
  FOR iteration IN 1..5 LOOP
    PERFORM * FROM public.albert_create_organisation(
      'Creation Limit ' || iteration::text,'Australia/Melbourne'
    );
  END LOOP;
  BEGIN
    PERFORM * FROM public.albert_create_organisation(
      'Creation Limit Bypass','Australia/Melbourne'
    );
    RAISE EXCEPTION 'the sixth explicit organisation creation succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
END;
$$;
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 6
     FROM control_plane.tenants
    WHERE created_by = '6f000000-0000-4000-8000-000000000001'),
  'bootstrap plus only five explicit organisations must exist'
);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 AND max(request_count) = 5
     FROM control_plane.user_rate_limit_buckets
    WHERE actor_digest = encode(extensions.digest(
      convert_to(
        'albert:user-rate-limit:v1:6f000000-0000-4000-8000-000000000001',
        'UTF8'
      ),'sha256'
    ),'hex')),
  'one pseudonymous user bucket must retain the five committed creations'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM control_plane.user_rate_limit_buckets
     WHERE actor_digest LIKE '%6f000000%'
        OR actor_digest !~ '^[a-f0-9]{64}$'
  ),
  'the bucket must not retain the Auth UUID'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM control_plane.rate_limit_buckets
     WHERE action = 'organisation.create'
  ),
  'organisation creation must not fall back to a selectable tenant bucket'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'authenticated','control_plane.user_rate_limit_buckets','SELECT'
  )
  AND NOT has_table_privilege(
    'service_role','control_plane.user_rate_limit_buckets','SELECT'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'control_plane.consume_organisation_creation_rate_limit()','EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'control_plane.purge_user_rate_limit_buckets()','EXECUTE'
  ),
  'the pseudonymous limiter must remain behind its fixed public creation RPC'
);

-- A second user has an independent bucket; selecting or creating tenants for
-- one actor cannot spend or reset another actor's limit.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub','6f000000-0000-4000-8000-000000000002',true
);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"6f000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant(
  'Creation Limit Other Root','Australia/Melbourne'
);
SELECT * FROM public.albert_create_organisation(
  'Creation Limit Other','Australia/Melbourne'
);
RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2
     FROM control_plane.user_rate_limit_buckets
    WHERE actor_digest IN (
      encode(extensions.digest(convert_to(
        'albert:user-rate-limit:v1:6f000000-0000-4000-8000-000000000001',
        'UTF8'
      ),'sha256'),'hex'),
      encode(extensions.digest(convert_to(
        'albert:user-rate-limit:v1:6f000000-0000-4000-8000-000000000002',
        'UTF8'
      ),'sha256'),'hex')
    )),
  'each Auth actor must receive an independent pseudonymous bucket'
);

ROLLBACK;
