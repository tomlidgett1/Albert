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
  protocol_version smallint NOT NULL DEFAULT 2 CHECK(protocol_version=2),
  repository text NOT NULL CHECK(repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  workflow_run_id text NOT NULL CHECK(workflow_run_id ~ '^[1-9][0-9]{0,19}$'),
  workflow_run_attempt integer NOT NULL CHECK(workflow_run_attempt BETWEEN 1 AND 10000),
  authority_sha text NOT NULL CHECK(authority_sha ~ '^[a-f0-9]{40}$'),
  authority_ref text NOT NULL CHECK(
    authority_ref ~ '^refs/tags/albert-release-authority-v[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  ),
  candidate_sha text NOT NULL CHECK(candidate_sha ~ '^[a-f0-9]{40}$'),
  candidate_image_digest text NOT NULL CHECK(candidate_image_digest ~ '^sha256:[a-f0-9]{64}$'),
  release_plan_digest text NOT NULL CHECK(release_plan_digest ~ '^[a-f0-9]{64}$'),
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
  ADD COLUMN IF NOT EXISTS checkpoint jsonb,
  ADD COLUMN IF NOT EXISTS protocol_version smallint,
  ADD COLUMN IF NOT EXISTS authority_sha text,
  ADD COLUMN IF NOT EXISTS authority_ref text,
  ADD COLUMN IF NOT EXISTS candidate_image_digest text,
  ADD COLUMN IF NOT EXISTS release_plan_digest text;

-- Preserve retained v1 rows as historical evidence while making every new
-- reservation explicitly v2. The v2 runtime refuses to resume a legacy row.
UPDATE capacity_trust.transform_attestations
   SET protocol_version=1
 WHERE protocol_version IS NULL;
ALTER TABLE capacity_trust.transform_attestations
  ALTER COLUMN protocol_version SET NOT NULL,
  ALTER COLUMN protocol_version SET DEFAULT 2;

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
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid='capacity_trust.transform_attestations'::regclass
       AND conname='transform_attestations_protocol_shape'
  ) THEN
    ALTER TABLE capacity_trust.transform_attestations
      ADD CONSTRAINT transform_attestations_protocol_shape
      CHECK (
        (protocol_version=1
          AND authority_sha IS NULL AND authority_ref IS NULL
          AND candidate_image_digest IS NULL AND release_plan_digest IS NULL)
        OR
        (protocol_version=2
          AND authority_sha ~ '^[a-f0-9]{40}$'
          AND authority_ref ~ '^refs/tags/albert-release-authority-v[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
          AND candidate_image_digest ~ '^sha256:[a-f0-9]{64}$'
          AND release_plan_digest ~ '^[a-f0-9]{64}$')
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
