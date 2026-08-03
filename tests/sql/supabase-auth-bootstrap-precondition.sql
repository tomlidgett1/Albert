BEGIN;

DO $$
DECLARE
  administrator pg_roles%ROWTYPE;
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'this proof requires the protected local Supabase postgres login';
  END IF;
  SELECT * INTO STRICT administrator FROM pg_roles WHERE rolname='postgres';
  IF administrator.rolsuper OR NOT administrator.rolcreaterole THEN
    RAISE EXCEPTION 'local Supabase postgres must be constrained and able to create Albert roles';
  END IF;
  IF NOT has_schema_privilege('postgres', 'auth', 'USAGE')
     OR NOT has_table_privilege('postgres', 'auth.users', 'REFERENCES') THEN
    RAISE EXCEPTION 'local Supabase postgres must hold the managed Auth compatibility privileges';
  END IF;
END;
$$;

CREATE ROLE albert_auth_grant_probe
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Managed Supabase emits warnings rather than errors here: postgres can use
-- these privileges but is not their owner and has no grant option.
GRANT USAGE ON SCHEMA auth TO albert_auth_grant_probe;
GRANT REFERENCES ON TABLE auth.users TO albert_auth_grant_probe;

DO $$
BEGIN
  IF has_schema_privilege('albert_auth_grant_probe', 'auth', 'USAGE')
     OR has_table_privilege('albert_auth_grant_probe', 'auth.users', 'REFERENCES') THEN
    RAISE EXCEPTION 'the test no longer reproduces the managed Auth grant-option boundary';
  END IF;
END;
$$;

ROLLBACK;
