-- Run once as the managed-Postgres administrative identity, never as an
-- application identity. Runtime credentials are LOGIN roles created by the
-- platform operator and granted exactly one of these NOLOGIN group roles.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'albert_migration_owner') THEN
    CREATE ROLE albert_migration_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ingest_rw') THEN
    CREATE ROLE ingest_rw NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'transform_rw') THEN
    CREATE ROLE transform_rw NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'semantic_ro') THEN
    CREATE ROLE semantic_ro NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'semantic_meta_rw') THEN
    CREATE ROLE semantic_meta_rw NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'diagnostic_ro') THEN
    CREATE ROLE diagnostic_ro NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'deletion_rw') THEN
    CREATE ROLE deletion_rw NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO albert_migration_owner, ingest_rw, transform_rw, semantic_ro, semantic_meta_rw, diagnostic_ro, deletion_rw',
    current_database()
  );
  EXECUTE format(
    'GRANT CREATE ON DATABASE %I TO albert_migration_owner',
    current_database()
  );
END;
$$;
