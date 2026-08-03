BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='albert_capacity_attestor_store') THEN
    CREATE ROLE albert_capacity_attestor_store LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
  END IF;
END
$$;

ALTER ROLE albert_capacity_attestor_store SET statement_timeout='5s';
ALTER ROLE albert_capacity_attestor_store SET lock_timeout='1s';
ALTER ROLE albert_capacity_attestor_store SET idle_in_transaction_session_timeout='10s';

CREATE SCHEMA IF NOT EXISTS capacity_trust;
REVOKE ALL ON SCHEMA capacity_trust FROM PUBLIC;

CREATE TABLE IF NOT EXISTS capacity_trust.transform_attestations (
  repository text NOT NULL CHECK(repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  workflow_run_id text NOT NULL CHECK(workflow_run_id ~ '^[1-9][0-9]{0,19}$'),
  workflow_run_attempt integer NOT NULL CHECK(workflow_run_attempt BETWEEN 1 AND 10000),
  candidate_sha text NOT NULL CHECK(candidate_sha ~ '^[a-f0-9]{40}$'),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  token_jti text NOT NULL CHECK(length(token_jti) BETWEEN 16 AND 200),
  status text NOT NULL CHECK(status IN ('running','completed','failed')),
  lease_token text CHECK(lease_token IS NULL OR lease_token ~ '^[a-f0-9]{64}$'),
  lease_expires_at timestamptz,
  checkpoint jsonb,
  envelope jsonb,
  error_code text CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY(repository,workflow_run_id,workflow_run_attempt),
  UNIQUE(token_jti),
  CHECK((status='running')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK((status='completed')=(envelope IS NOT NULL AND completed_at IS NOT NULL))
);

ALTER TABLE capacity_trust.transform_attestations
  ADD COLUMN IF NOT EXISTS checkpoint jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid='capacity_trust.transform_attestations'::regclass
       AND conname='transform_attestations_checkpoint_shape'
  ) THEN
    ALTER TABLE capacity_trust.transform_attestations
      ADD CONSTRAINT transform_attestations_checkpoint_shape
      CHECK (
        checkpoint IS NULL
        OR (status='running' AND jsonb_typeof(checkpoint)='object')
      );
  END IF;
END
$$;

REVOKE ALL ON TABLE capacity_trust.transform_attestations FROM PUBLIC;
GRANT USAGE ON SCHEMA capacity_trust TO albert_capacity_attestor_store;
GRANT SELECT,INSERT,UPDATE ON TABLE capacity_trust.transform_attestations
  TO albert_capacity_attestor_store;

COMMIT;

-- Set the login password from the trust platform's secret manager after this
-- bootstrap. Never add it to SQL, candidate CI, or the Albert repository.
