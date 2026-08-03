BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', message;
  END IF;
END;
$$;

SELECT pg_temp.assert_true(
  NOT (SELECT rolinherit FROM pg_roles WHERE rolname='albert_control_migration_owner'),
  'the migration owner must remain NOINHERIT'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM pg_auth_members
     WHERE member='albert_control_migration_owner'::regrole
  ),
  'the migration owner must have zero parent-role memberships'
);
SELECT pg_temp.assert_true(
  NOT has_schema_privilege('albert_control_migration_owner', 'auth', 'USAGE'),
  'the migration owner must not inherit the managed Auth schema'
);
SELECT pg_temp.assert_true(
  NOT has_any_column_privilege(
    'albert_control_migration_owner',
    'auth.users',
    'SELECT'
  ),
  'the migration owner must not read the Auth user directory directly'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'albert_control_migration_owner',
    'auth.users',
    'REFERENCES'
  ),
  'the migration owner must not retain managed Auth reference authority'
);

SELECT pg_temp.assert_true(
  (SELECT count(*)=29
     FROM pg_constraint AS constraint_row
     JOIN pg_class AS source_table ON source_table.oid=constraint_row.conrelid
     JOIN pg_namespace AS source_schema ON source_schema.oid=source_table.relnamespace
     JOIN pg_class AS referenced ON referenced.oid=constraint_row.confrelid
     JOIN pg_namespace AS referenced_schema ON referenced_schema.oid=referenced.relnamespace
    WHERE constraint_row.contype='f'
      AND source_schema.nspname='control_plane'
      AND referenced_schema.nspname='auth'
      AND referenced.relname='users'),
  'all 29 fixed Auth user references must be installed'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS source_table ON source_table.oid=constraint_row.conrelid
      JOIN pg_namespace AS source_schema ON source_schema.oid=source_table.relnamespace
      JOIN pg_class AS referenced ON referenced.oid=constraint_row.confrelid
      JOIN pg_namespace AS referenced_schema ON referenced_schema.oid=referenced.relnamespace
     WHERE constraint_row.contype='f'
       AND source_schema.nspname='control_plane'
       AND referenced_schema.nspname='auth'
       AND referenced.relname='users'
       AND source_table.relowner<>'albert_control_migration_owner'::regrole
  ),
  'every Auth-referencing application table must remain migration-owned'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege(
    'albert_control_migration_owner',
    'extensions.albert_install_auth_user_foreign_keys()',
    'EXECUTE'
  ),
  'the no-argument Auth reference installer must self-revoke'
);
SELECT pg_temp.assert_true(
  NOT has_function_privilege(
    'albert_control_migration_owner',
    'extensions.albert_install_raw_payload_bucket()',
    'EXECUTE'
  ),
  'the no-argument raw bucket installer must self-revoke'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1 FROM storage.buckets
     WHERE id='raw-payloads'
       AND name='raw-payloads'
       AND public=false
       AND file_size_limit=52428800
       AND allowed_mime_types=ARRAY['application/gzip','application/x-gzip']::text[]
  ),
  'the private raw payload bucket must have its exact fixed definition'
);

SELECT pg_temp.assert_true(
  pg_get_userbyid((
    SELECT proowner FROM pg_proc
     WHERE oid='extensions.albert_auth_uid()'::regprocedure
  ))='postgres',
  'the claim bridge must remain administrator-owned'
);
SELECT pg_temp.assert_true(
  has_function_privilege('anon', 'extensions.albert_auth_uid()', 'EXECUTE')
  AND has_function_privilege('authenticated', 'extensions.albert_auth_uid()', 'EXECUTE')
  AND has_function_privilege(
    'albert_control_migration_owner',
    'extensions.albert_auth_uid()',
    'EXECUTE'
  )
  AND NOT has_function_privilege('service_role', 'extensions.albert_auth_uid()', 'EXECUTE'),
  'claim access must be limited to policy callers and the migration owner'
);
SELECT pg_temp.assert_true(
  has_function_privilege(
    'albert_control_migration_owner',
    'extensions.albert_auth_users_by_ids(uuid[])',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'extensions.albert_auth_users_by_ids(uuid[])',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'service_role',
    'extensions.albert_auth_confirmed_user_by_email(text)',
    'EXECUTE'
  ),
  'directory lookups must remain private migration-owner capabilities'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
      FROM pg_proc AS routine
     WHERE routine.proowner='albert_control_migration_owner'::regrole
       AND position('auth'||'.'||'users' in pg_get_functiondef(routine.oid))>0
  ),
  'migration-owned routines must not read the Auth directory directly'
);

SELECT set_config('request.jwt.claim.sub', '5a000000-0000-4000-8000-000000000001', true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"5a000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{}}',
  true
);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true(
  extensions.albert_auth_uid()='5a000000-0000-4000-8000-000000000001'::uuid,
  'the fixed claim bridge must preserve the authenticated caller identity'
);
DO $$
BEGIN
  PERFORM * FROM extensions.albert_auth_users_by_ids(
    ARRAY['5a000000-0000-4000-8000-000000000001'::uuid]
  );
  RAISE EXCEPTION 'authenticated unexpectedly executed the private Auth directory helper';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$$;
RESET ROLE;

CREATE TABLE control_plane.auth_reference_probe(user_id uuid);
ALTER TABLE control_plane.auth_reference_probe OWNER TO albert_control_migration_owner;
SET LOCAL ROLE albert_control_migration_owner;
DO $$
BEGIN
  INSERT INTO storage.buckets(id,name,public)
  VALUES('albert-boundary-probe','albert-boundary-probe',false);
  RAISE EXCEPTION 'migration owner unexpectedly bypassed Storage bucket RLS';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$$;
DO $$
BEGIN
  PERFORM id FROM auth.users LIMIT 1;
  RAISE EXCEPTION 'migration owner unexpectedly read the managed Auth directory';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$$;
DO $$
BEGIN
  ALTER TABLE control_plane.auth_reference_probe
    ADD CONSTRAINT auth_reference_probe_user_id_fkey
    FOREIGN KEY(user_id) REFERENCES auth.users(id);
  RAISE EXCEPTION 'migration owner unexpectedly manufactured an Auth reference';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$$;
DO $$
BEGIN
  INSERT INTO control_plane.tenants(
    tenant_id, display_name, slug, status, created_by
  ) VALUES (
    '01K70000000000000000000099',
    'Auth boundary probe',
    'auth-boundary-probe',
    'active',
    '5a000000-0000-4000-8000-000000000099'
  );
  RAISE EXCEPTION 'a fixed Auth reference accepted a nonexistent user';
EXCEPTION WHEN foreign_key_violation THEN
  NULL;
END;
$$;
RESET ROLE;

ROLLBACK;
