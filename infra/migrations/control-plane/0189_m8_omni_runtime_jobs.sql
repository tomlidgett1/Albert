-- ADR 0135: encrypted, fenced, short-lived Omni execution checkpoints.
BEGIN;

CREATE TABLE control_plane.omni_job_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO control_plane.omni_job_status_lookup VALUES
  ('queued', 'Accepted and waiting for execution'),
  ('running', 'Execution has a saved checkpoint'),
  ('complete', 'Answer and terminal result are saved'),
  ('failed', 'A terminal failure is saved');

CREATE TABLE control_plane.omni_runtime_jobs (
  job_id text PRIMARY KEY CHECK (control_plane.is_ulid(job_id)),
  tenant_id text NOT NULL,
  turn_id text NOT NULL,
  actor_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'queued' REFERENCES control_plane.omni_job_status_lookup(status),
  snapshot bytea NOT NULL CHECK (octet_length(snapshot) BETWEEN 29 AND 50331676),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  lease_owner uuid,
  lease_until timestamptz,
  deadline_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, turn_id) REFERENCES control_plane.conversation_turns(tenant_id, turn_id) ON DELETE CASCADE,
  CHECK (expires_at > deadline_at)
);
CREATE INDEX omni_runtime_jobs_tenant_turn_idx ON control_plane.omni_runtime_jobs (tenant_id, turn_id);
CREATE INDEX omni_runtime_jobs_expiry_idx ON control_plane.omni_runtime_jobs (expires_at);
ALTER TABLE control_plane.omni_runtime_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.omni_runtime_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY omni_executor_jobs ON control_plane.omni_runtime_jobs
  TO albert_omni_control USING (true) WITH CHECK (true);
REVOKE ALL ON control_plane.omni_runtime_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON control_plane.omni_job_status_lookup FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA control_plane TO albert_omni_control;
GRANT SELECT, INSERT, UPDATE, DELETE ON control_plane.omni_runtime_jobs TO albert_omni_control;
GRANT SELECT ON control_plane.omni_job_status_lookup TO albert_omni_control;
GRANT EXECUTE ON FUNCTION control_plane.is_ulid(text) TO albert_omni_control;
SELECT public.albert_install_omni_job_retention();

COMMIT;
