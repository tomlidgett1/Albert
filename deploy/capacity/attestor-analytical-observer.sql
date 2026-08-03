BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='albert_capacity_analytical_observer') THEN
    CREATE ROLE albert_capacity_analytical_observer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
  END IF;
END
$$;

ALTER ROLE albert_capacity_analytical_observer SET default_transaction_read_only=on;
ALTER ROLE albert_capacity_analytical_observer SET statement_timeout='5s';
ALTER ROLE albert_capacity_analytical_observer SET lock_timeout='500ms';
ALTER ROLE albert_capacity_analytical_observer SET idle_in_transaction_session_timeout='10s';
GRANT CONNECT ON DATABASE postgres TO albert_capacity_analytical_observer;

COMMIT;

-- This login observes only pg_catalog connection/deadlock/lock pressure in the
-- isolated capacity analytical cell. It receives no table or schema grant.
