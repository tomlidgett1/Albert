BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='albert_capacity_control_observer') THEN
    CREATE ROLE albert_capacity_control_observer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
  END IF;
END
$$;

ALTER ROLE albert_capacity_control_observer SET default_transaction_read_only=on;
ALTER ROLE albert_capacity_control_observer SET statement_timeout='5s';
ALTER ROLE albert_capacity_control_observer SET lock_timeout='500ms';
ALTER ROLE albert_capacity_control_observer SET idle_in_transaction_session_timeout='10s';
GRANT CONNECT ON DATABASE postgres TO albert_capacity_control_observer;
GRANT USAGE ON SCHEMA control_plane,extensions TO albert_capacity_control_observer;
GRANT SELECT ON TABLE
  control_plane.tenants,
  control_plane.connections,
  control_plane.deletion_requests,
  control_plane.canonical_transform_jobs,
  control_plane.transform_maintenance_leases,
  control_plane.transform_capacity_participant_observations,
  control_plane.pipeline_stats
TO albert_capacity_control_observer;
GRANT EXECUTE ON FUNCTION extensions.digest(text,text)
  TO albert_capacity_control_observer;

COMMIT;

-- This script is applied only to the isolated Sydney capacity cell by its
-- administrator. The observer has no write, role-membership, or customer-cell
-- authority. Supply its password out of band from the attestor trust domain.
