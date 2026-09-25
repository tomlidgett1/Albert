BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='albert_omni_control') THEN
    CREATE ROLE albert_omni_control NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO albert_omni_control', current_database());
END $$;
GRANT albert_omni_control TO postgres;

-- A fixed installer lets the migration owner arrange deletion without cron authority.
CREATE OR REPLACE FUNCTION public.albert_install_omni_job_retention()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM cron.schedule('albert-omni-job-retention', '17 * * * *',
    'SET ROLE albert_omni_control; DELETE FROM control_plane.omni_runtime_jobs WHERE expires_at < clock_timestamp(); RESET ROLE;');
END $$;
REVOKE ALL ON FUNCTION public.albert_install_omni_job_retention() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.albert_install_omni_job_retention() TO albert_control_migration_owner;
COMMIT;
