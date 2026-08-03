-- DISPOSABLE TEST DATABASES ONLY. Production administrator sessions never
-- receive runtime-role memberships. The integration harness switches roles in
-- one transaction, which a managed non-superuser postgres login cannot do
-- unless the test database grants these exact SET-only memberships.
BEGIN;

DO $$
BEGIN
  IF current_setting('albert.test_role_delegation', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'set albert.test_role_delegation=on only in a disposable test database';
  END IF;
  IF current_user<>'postgres' OR session_user<>'postgres' THEN
    RAISE EXCEPTION 'test role delegation requires the local Supabase postgres login';
  END IF;
END;
$$;

GRANT albert_deletion_control,
      albert_sync_control,
      albert_webhook_control,
      albert_transform_control,
      albert_semantic_control
TO postgres
WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

DO $$
DECLARE
  required_role text;
BEGIN
  FOREACH required_role IN ARRAY ARRAY[
    'albert_deletion_control',
    'albert_sync_control',
    'albert_webhook_control',
    'albert_transform_control',
    'albert_semantic_control'
  ] LOOP
    IF NOT pg_has_role('postgres', required_role, 'SET') THEN
      RAISE EXCEPTION 'test postgres cannot SET ROLE %', required_role;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
