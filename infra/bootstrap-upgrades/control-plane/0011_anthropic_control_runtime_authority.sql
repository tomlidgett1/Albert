BEGIN;

-- Existing control-plane databases predate the isolated Anthropic runtime.
-- Install its NOLOGIN authority group through the protected administrator
-- stream; fresh databases receive the same role from control_plane_role.sql.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname='albert_anthropic_control'
  ) THEN
    CREATE ROLE albert_anthropic_control
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;

ALTER ROLE albert_anthropic_control NOINHERIT;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO albert_anthropic_control',
    current_database()
  );
END;
$$;

COMMIT;
