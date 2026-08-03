BEGIN;

-- Analytical tenant scope is an authorization claim, not a caller-selected
-- session variable.  The signing key is installed out-of-band by an
-- administrator and is never readable by a runtime identity.
CREATE TABLE control_plane.analytical_capability_keys (
  key_id text PRIMARY KEY CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  secret bytea NOT NULL CHECK (octet_length(secret) BETWEEN 32 AND 64),
  fingerprint text NOT NULL UNIQUE CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  active_at timestamptz NOT NULL,
  retire_at timestamptz NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (retire_at > active_at + interval '5 minutes')
);

REVOKE ALL ON TABLE control_plane.analytical_capability_keys
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_transform_control,albert_semantic_control,albert_webhook_control,
       albert_deletion_control,albert_operator_diagnostic_control;

CREATE OR REPLACE FUNCTION control_plane.install_analytical_capability_key(
  p_key_id text,
  p_secret_base64 text,
  p_active_at timestamptz,
  p_retire_at timestamptz
) RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $$
DECLARE
  decoded bytea;
  digest text;
BEGIN
  IF current_user <> 'albert_control_migration_owner' THEN
    RAISE EXCEPTION 'capability keys can only be installed by the migration owner'
      USING ERRCODE='42501';
  END IF;
  IF p_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
     OR p_secret_base64 IS NULL OR length(p_secret_base64) NOT BETWEEN 44 AND 88
     OR p_active_at IS NULL OR p_retire_at IS NULL
     OR p_retire_at <= p_active_at + interval '5 minutes' THEN
    RAISE EXCEPTION 'analytical capability key metadata is invalid' USING ERRCODE='22023';
  END IF;
  BEGIN
    decoded := decode(p_secret_base64,'base64');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'analytical capability key encoding is invalid' USING ERRCODE='22023';
  END;
  IF octet_length(decoded) NOT BETWEEN 32 AND 64 THEN
    RAISE EXCEPTION 'analytical capability key must contain 32 to 64 bytes'
      USING ERRCODE='22023';
  END IF;
  digest := encode(extensions.digest(decoded,'sha256'),'hex');
  IF EXISTS(
    SELECT 1 FROM control_plane.analytical_capability_keys key
    WHERE key.key_id=p_key_id AND key.secret<>decoded
  ) THEN
    RAISE EXCEPTION 'analytical capability key identifiers are immutable'
      USING ERRCODE='22023';
  END IF;
  INSERT INTO control_plane.analytical_capability_keys(
    key_id,secret,fingerprint,active_at,retire_at
  ) VALUES (p_key_id,decoded,digest,p_active_at,p_retire_at)
  ON CONFLICT(key_id) DO UPDATE SET
    secret=excluded.secret,
    fingerprint=excluded.fingerprint,
    active_at=excluded.active_at,
    retire_at=excluded.retire_at,
    installed_at=clock_timestamp();
  RETURN digest;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.retire_analytical_capability_key(
  p_key_id text,p_retire_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $$
BEGIN
  IF current_user<>'albert_control_migration_owner' THEN
    RAISE EXCEPTION 'capability keys can only be retired by the migration owner'
      USING ERRCODE='42501';
  END IF;
  IF p_retire_at<=clock_timestamp()+interval '10 minutes' THEN
    RAISE EXCEPTION 'capability key retirement requires a ten-minute drain window'
      USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM control_plane.analytical_capability_keys replacement
     WHERE replacement.key_id<>p_key_id
       AND replacement.active_at<=p_retire_at-interval '5 minutes'
       AND replacement.retire_at>p_retire_at+interval '5 minutes'
  ) THEN
    RAISE EXCEPTION 'capability key retirement has no overlapping replacement'
      USING ERRCODE='55000';
  END IF;
  UPDATE control_plane.analytical_capability_keys key
     SET retire_at=p_retire_at
   WHERE key.key_id=p_key_id AND p_retire_at>key.active_at+interval '5 minutes';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capability key retirement target is invalid' USING ERRCODE='22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.prune_retired_analytical_capability_keys()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $$
DECLARE removed integer;
BEGIN
  IF current_user<>'albert_control_migration_owner' THEN
    RAISE EXCEPTION 'capability keys can only be pruned by the migration owner'
      USING ERRCODE='42501';
  END IF;
  DELETE FROM control_plane.analytical_capability_keys key
   WHERE key.retire_at<clock_timestamp()-interval '10 minutes';
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.install_analytical_capability_key(text,text,timestamptz,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_transform_control,albert_semantic_control,albert_webhook_control,
       albert_deletion_control,albert_operator_diagnostic_control;
REVOKE ALL ON FUNCTION control_plane.retire_analytical_capability_key(text,timestamptz),
  control_plane.prune_retired_analytical_capability_keys()
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_transform_control,albert_semantic_control,albert_webhook_control,
       albert_deletion_control,albert_operator_diagnostic_control;
GRANT EXECUTE ON FUNCTION
  control_plane.install_analytical_capability_key(text,text,timestamptz,timestamptz),
  control_plane.retire_analytical_capability_key(text,timestamptz),
  control_plane.prune_retired_analytical_capability_keys()
  TO albert_control_migration_owner;

CREATE OR REPLACE FUNCTION control_plane.assert_analytical_capability_issuer_ready()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.analytical_capability_keys key
     WHERE key.active_at <= statement_timestamp()
       AND key.retire_at > statement_timestamp() + interval '5 minutes'
  ) THEN
    RAISE EXCEPTION 'no active analytical capability signing key is installed'
      USING ERRCODE='55000';
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.require_exact_runtime_login(
  p_login name,p_group name
) RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  login_oid oid;
  unsafe boolean;
BEGIN
  SELECT role.oid,
         role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
           OR role.rolreplication OR role.rolbypassrls OR role.rolinherit
    INTO login_oid,unsafe
    FROM pg_catalog.pg_roles role
   WHERE role.rolname=session_user;
  IF session_user::name IS DISTINCT FROM p_login OR login_oid IS NULL OR unsafe
     OR NOT pg_catalog.pg_has_role(session_user,p_group,'member') THEN
    RAISE EXCEPTION 'analytical capability caller has an unsafe runtime identity'
      USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
    WHERE membership.member=login_oid AND granted.rolname<>p_group
  ) THEN
    RAISE EXCEPTION 'analytical capability caller has an unexpected role membership'
      USING ERRCODE='42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.sign_analytical_capability(
  p_tenant_id text,
  p_audience text,
  p_scope text,
  p_subject text,
  p_expires_at timestamptz,
  p_evidence jsonb
) RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  key_row control_plane.analytical_capability_keys%ROWTYPE;
  issued_at timestamptz:=clock_timestamp();
  deadline timestamptz;
  payload jsonb;
  signature text;
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR p_audience !~ '^analytical:[a-z][a-z0-9-]{1,63}$'
     OR p_scope NOT IN (
       'ingest','transform','semantic_read','semantic_metadata','diagnostic',
       'deletion_purge','deletion_verify'
     )
     OR length(btrim(p_subject)) NOT BETWEEN 3 AND 320
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object' THEN
    RAISE EXCEPTION 'analytical capability claims are invalid' USING ERRCODE='22023';
  END IF;
  IF p_scope NOT IN ('deletion_purge','deletion_verify') THEN
    PERFORM 1 FROM control_plane.tenants tenant
     WHERE tenant.tenant_id=p_tenant_id AND tenant.status='active'
     FOR SHARE;
    IF NOT FOUND OR EXISTS(
      SELECT 1 FROM control_plane.deletion_requests request
       WHERE request.tenant_id=p_tenant_id
         AND request.status IN ('queued','running','retry_wait','verifying','failed')
    ) THEN
      RAISE EXCEPTION 'analytical capability issuance is fenced by tenant deletion'
        USING ERRCODE='55000';
    END IF;
  END IF;
  SELECT * INTO key_row
    FROM control_plane.analytical_capability_keys key
   WHERE key.active_at<=issued_at AND key.retire_at>issued_at+interval '5 minutes'
   ORDER BY key.active_at DESC,key.key_id DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active analytical capability signing key is installed'
      USING ERRCODE='55000';
  END IF;
  deadline:=least(p_expires_at,issued_at+interval '5 minutes',key_row.retire_at);
  IF deadline<=issued_at+interval '2 seconds' THEN
    RAISE EXCEPTION 'analytical capability evidence expires too soon' USING ERRCODE='55000';
  END IF;
  payload:=jsonb_build_object(
    'version',1,
    'key_id',key_row.key_id,
    'tenant_id',p_tenant_id,
    'audience',p_audience,
    'scope',p_scope,
    'subject',p_subject,
    'nonce',control_plane.generate_ulid(),
    'issued_at',floor(extract(epoch FROM issued_at))::bigint,
    'expires_at',floor(extract(epoch FROM deadline))::bigint,
    'evidence',p_evidence
  );
  signature:=encode(
    extensions.hmac(convert_to(payload::text,'utf8'),key_row.secret,'sha256'),
    'hex'
  );
  RETURN jsonb_build_object('payload',payload,'signature',signature)::text;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.require_exact_runtime_login(name,name),
  control_plane.sign_analytical_capability(text,text,text,text,timestamptz,jsonb)
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_transform_control,albert_semantic_control,albert_webhook_control,
       albert_deletion_control,albert_operator_diagnostic_control;

-- Semantic claims are possible only while the exact durable conversation turn
-- is running under its crash-recovery lease.  A leaked semantic credential
-- cannot choose a tenant without also presenting that unguessable live proof.
CREATE OR REPLACE FUNCTION control_plane.issue_semantic_analytical_capability(
  p_tenant_id text,p_conversation_id text,p_turn_id text,p_scope text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  turn_row control_plane.conversation_turns%ROWTYPE;
  audience text;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_semantic_control_runtime','albert_semantic_control'
  );
  IF p_scope NOT IN ('semantic_read','semantic_metadata') THEN
    RAISE EXCEPTION 'semantic analytical scope is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO turn_row FROM control_plane.conversation_turns turn_record
   WHERE turn_record.tenant_id=p_tenant_id
     AND turn_record.conversation_id=p_conversation_id
     AND turn_record.turn_id=p_turn_id
     AND turn_record.status='running'
     AND turn_record.lease_expires_at>clock_timestamp()
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'semantic turn lease is not active' USING ERRCODE='55000';
  END IF;
  audience:=CASE p_scope
    WHEN 'semantic_read' THEN 'analytical:semantic-read'
    ELSE 'analytical:semantic-metadata' END;
  RETURN control_plane.sign_analytical_capability(
    p_tenant_id,audience,p_scope,
    'conversation:'||p_conversation_id||':turn:'||p_turn_id,
    turn_row.lease_expires_at,
    jsonb_build_object('conversation_id',p_conversation_id,'turn_id',p_turn_id)
  );
END;
$$;

-- Canonical transform jobs inherit the source authorization epoch.  Existing
-- rows are backfilled from their immutable sync-run parent before the column
-- becomes mandatory.
ALTER TABLE control_plane.canonical_transform_jobs
  ADD COLUMN IF NOT EXISTS connection_generation bigint;
UPDATE control_plane.canonical_transform_jobs job
   SET connection_generation=run.connection_generation
  FROM control_plane.sync_runs run
 WHERE run.tenant_id=job.tenant_id AND run.sync_run_id=job.sync_run_id
   AND job.connection_generation IS NULL;
ALTER TABLE control_plane.canonical_transform_jobs
  ALTER COLUMN connection_generation SET NOT NULL;
ALTER TABLE control_plane.canonical_transform_jobs
  DROP CONSTRAINT IF EXISTS canonical_transform_jobs_generation_positive;
ALTER TABLE control_plane.canonical_transform_jobs
  ADD CONSTRAINT canonical_transform_jobs_generation_positive
  CHECK(connection_generation>0);

CREATE OR REPLACE FUNCTION control_plane.issue_transform_job_analytical_capability(
  p_tenant_id text,p_transform_job_id text,p_worker_id text,p_lease_token text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE job_row control_plane.canonical_transform_jobs%ROWTYPE;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_transform_control_runtime','albert_transform_control'
  );
  SELECT job.* INTO job_row
    FROM control_plane.canonical_transform_jobs job
    JOIN control_plane.connections connection
      ON connection.tenant_id=job.tenant_id AND connection.connection_id=job.connection_id
    JOIN control_plane.tenants tenant ON tenant.tenant_id=job.tenant_id
   WHERE job.tenant_id=p_tenant_id AND job.transform_job_id=p_transform_job_id
     AND job.status='running' AND job.lease_owner=p_worker_id
     AND job.lease_token=p_lease_token AND job.lease_expires_at>clock_timestamp()
     AND connection.connection_generation=job.connection_generation
     AND connection.status IN ('connected','degraded') AND tenant.status='active'
     AND NOT EXISTS (
       SELECT 1 FROM control_plane.deletion_requests request
       WHERE request.tenant_id=job.tenant_id
         AND (request.scope='tenant' OR request.connection_id=job.connection_id)
         AND request.status IN ('queued','running','retry_wait','verifying','failed')
     )
   FOR SHARE OF job,connection,tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical transform lease is not active' USING ERRCODE='55000';
  END IF;
  RETURN control_plane.sign_analytical_capability(
    job_row.tenant_id,'analytical:transform','transform',
    'transform-job:'||job_row.transform_job_id,
    job_row.lease_expires_at,
    jsonb_build_object(
      'kind','canonical_transform','transform_job_id',job_row.transform_job_id,
      'connection_id',job_row.connection_id,
      'connection_generation',job_row.connection_generation,
      'sync_run_id',job_row.sync_run_id,'batch_id',job_row.batch_id,
      'worker_id',p_worker_id,'lease_token',p_lease_token
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.issue_identity_projection_analytical_capability(
  p_tenant_id text,p_projection_id text,p_worker_id text,p_lease_token text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  projection record;
  connection_generations jsonb;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_transform_control_runtime','albert_transform_control'
  );
  SELECT item.tenant_id,item.projection_id,item.decision_id,item.lease_expires_at
    INTO projection
    FROM control_plane.identity_decision_projection_outbox item
    JOIN control_plane.tenants tenant ON tenant.tenant_id=item.tenant_id
   WHERE item.tenant_id=p_tenant_id AND item.projection_id=p_projection_id
     AND item.status='running' AND item.lease_owner=p_worker_id
     AND item.lease_token=p_lease_token AND item.lease_expires_at>clock_timestamp()
     AND tenant.status='active'
     AND NOT EXISTS(
       SELECT 1 FROM control_plane.deletion_requests request
       WHERE request.tenant_id=item.tenant_id
         AND request.status IN ('queued','running','retry_wait','verifying','failed')
     )
   FOR SHARE OF item,tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'identity projection lease is not active' USING ERRCODE='55000';
  END IF;
  -- Identity decisions may reference several source systems. Lock every
  -- connection row so reconnect and deletion cannot cross the analytical
  -- transaction consuming this exact projection lease.
  PERFORM connection.connection_id
    FROM control_plane.connections connection
   WHERE connection.tenant_id=projection.tenant_id
   ORDER BY connection.connection_id
   FOR SHARE;
  SELECT coalesce(jsonb_object_agg(connection.connection_id,
           connection.connection_generation ORDER BY connection.connection_id),'{}'::jsonb)
    INTO connection_generations
    FROM control_plane.connections connection
   WHERE connection.tenant_id=projection.tenant_id
     AND connection.status IN ('connected','degraded');
  RETURN control_plane.sign_analytical_capability(
    projection.tenant_id,'analytical:transform','transform',
    'identity-projection:'||projection.projection_id,
    projection.lease_expires_at,
    jsonb_build_object(
      'kind','identity_projection','projection_id',projection.projection_id,
      'decision_id',projection.decision_id,'worker_id',p_worker_id,
      'lease_token',p_lease_token,'connection_generations',connection_generations
    )
  );
END;
$$;

CREATE TABLE control_plane.transform_maintenance_leases (
  authorization_id text PRIMARY KEY CHECK(control_plane.is_ulid(authorization_id)),
  tenant_id text NOT NULL REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK(purpose='pipeline_snapshot'),
  worker_id text NOT NULL CHECK(length(btrim(worker_id)) BETWEEN 1 AND 160),
  lease_token text NOT NULL UNIQUE CHECK(control_plane.is_ulid(lease_token)),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  authorization_evidence jsonb NOT NULL
    CHECK(jsonb_typeof(authorization_evidence)='object'),
  CHECK(expires_at>claimed_at AND expires_at<=claimed_at+interval '10 minutes'),
  CHECK(completed_at IS NULL OR completed_at>=claimed_at)
);
CREATE INDEX transform_maintenance_leases_due_idx
  ON control_plane.transform_maintenance_leases(tenant_id,purpose,completed_at,expires_at);
REVOKE ALL ON TABLE control_plane.transform_maintenance_leases
  FROM PUBLIC,anon,authenticated,service_role,albert_transform_control;

CREATE OR REPLACE FUNCTION control_plane.claim_transform_maintenance_leases(
  p_worker_id text,p_limit integer DEFAULT 100
) RETURNS TABLE(
  authorization_id text,tenant_id text,lease_token text,expires_at timestamptz,
  source_watermarks jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE candidate record;generated_id text;generated_token text;deadline timestamptz;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_transform_control_runtime','albert_transform_control'
  );
  IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160 OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'transform maintenance claim input is invalid' USING ERRCODE='22023';
  END IF;
  DELETE FROM control_plane.transform_maintenance_leases lease
   WHERE lease.completed_at IS NULL AND lease.expires_at<=clock_timestamp();
  FOR candidate IN
    SELECT tenant.tenant_id,watermarks.source_watermarks,
           generations.connection_generations
    FROM control_plane.tenants tenant
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_object_agg(latest.connection_id,latest.source_watermark)
        FILTER(WHERE latest.connection_id IS NOT NULL AND latest.source_watermark IS NOT NULL),'{}'::jsonb)
        AS source_watermarks
      FROM (
        SELECT cursor.connection_id,max(cursor.source_watermark) AS source_watermark
        FROM control_plane.stream_cursors cursor
        WHERE cursor.tenant_id=tenant.tenant_id
        GROUP BY cursor.connection_id
      ) latest
    ) watermarks
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_object_agg(connection.connection_id,
               connection.connection_generation ORDER BY connection.connection_id),'{}'::jsonb)
        AS connection_generations
      FROM control_plane.connections connection
      WHERE connection.tenant_id=tenant.tenant_id
        AND connection.status IN ('connected','degraded')
    ) generations
    WHERE tenant.status='active'
      AND generations.connection_generations<>'{}'::jsonb
      AND NOT EXISTS (
        SELECT 1 FROM control_plane.deletion_requests request
        WHERE request.tenant_id=tenant.tenant_id
          AND request.status IN ('queued','running','retry_wait','verifying','failed')
      )
      AND NOT EXISTS (
        SELECT 1 FROM control_plane.transform_maintenance_leases recent
        WHERE recent.tenant_id=tenant.tenant_id AND recent.purpose='pipeline_snapshot'
          AND (recent.expires_at>clock_timestamp() OR recent.completed_at>clock_timestamp()-interval '50 minutes')
      )
    ORDER BY tenant.tenant_id
    FOR UPDATE OF tenant SKIP LOCKED
    LIMIT p_limit
  LOOP
    generated_id:=control_plane.generate_ulid();
    generated_token:=control_plane.generate_ulid();
    deadline:=clock_timestamp()+interval '10 minutes';
    INSERT INTO control_plane.transform_maintenance_leases(
      authorization_id,tenant_id,purpose,worker_id,lease_token,expires_at,
      authorization_evidence
    ) VALUES(
      generated_id,candidate.tenant_id,'pipeline_snapshot',p_worker_id,
      generated_token,deadline,
      jsonb_build_object(
        'source_watermarks',candidate.source_watermarks,
        'connection_generations',candidate.connection_generations
      )
    );
    authorization_id:=generated_id;tenant_id:=candidate.tenant_id;lease_token:=generated_token;
    expires_at:=deadline;source_watermarks:=candidate.source_watermarks;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_transform_maintenance(
  p_authorization_id text,p_worker_id text,p_lease_token text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_transform_control_runtime','albert_transform_control'
  );
  UPDATE control_plane.transform_maintenance_leases lease SET completed_at=clock_timestamp()
   WHERE lease.authorization_id=p_authorization_id AND lease.worker_id=p_worker_id
     AND lease.lease_token=p_lease_token AND lease.completed_at IS NULL
     AND lease.expires_at>clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transform maintenance lease is not active' USING ERRCODE='55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.issue_transform_maintenance_analytical_capability(
  p_authorization_id text,p_worker_id text,p_lease_token text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  lease_row control_plane.transform_maintenance_leases%ROWTYPE;
  connection_generations jsonb;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_transform_control_runtime','albert_transform_control'
  );
  SELECT lease.* INTO lease_row
    FROM control_plane.transform_maintenance_leases lease
    JOIN control_plane.tenants tenant ON tenant.tenant_id=lease.tenant_id
   WHERE lease.authorization_id=p_authorization_id AND lease.worker_id=p_worker_id
     AND lease.lease_token=p_lease_token AND lease.completed_at IS NULL
     AND lease.expires_at>clock_timestamp() AND tenant.status='active'
     AND NOT EXISTS(
       SELECT 1 FROM control_plane.deletion_requests request
       WHERE request.tenant_id=lease.tenant_id
         AND request.status IN ('queued','running','retry_wait','verifying','failed')
     )
   FOR SHARE OF lease,tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transform maintenance lease is not active' USING ERRCODE='55000';
  END IF;
  -- Lock disconnected rows too: reconnect changes the same row and therefore
  -- cannot commit until the protected analytical transaction finishes.
  PERFORM connection.connection_id
    FROM control_plane.connections connection
   WHERE connection.tenant_id=lease_row.tenant_id
   ORDER BY connection.connection_id
   FOR SHARE;
  SELECT coalesce(jsonb_object_agg(connection.connection_id,
           connection.connection_generation ORDER BY connection.connection_id),'{}'::jsonb)
    INTO connection_generations
    FROM control_plane.connections connection
   WHERE connection.tenant_id=lease_row.tenant_id
     AND connection.status IN ('connected','degraded');
  IF connection_generations IS DISTINCT FROM
       lease_row.authorization_evidence->'connection_generations' THEN
    RAISE EXCEPTION 'transform maintenance lease is fenced by connection generation change'
      USING ERRCODE='55000';
  END IF;
  RETURN control_plane.sign_analytical_capability(
    lease_row.tenant_id,'analytical:transform','transform',
    'transform-maintenance:'||lease_row.authorization_id,lease_row.expires_at,
    jsonb_build_object('kind',lease_row.purpose,'authorization_id',lease_row.authorization_id,
      'worker_id',p_worker_id,'lease_token',p_lease_token,
      'connection_generations',connection_generations)
  );
END;
$$;

-- Replace caller-generated sync permits with server-generated permits bound to
-- the exact active pgmq job attempt and connection authorization generation.
DELETE FROM control_plane.sync_write_permits;
ALTER TABLE control_plane.sync_write_permits
  ADD COLUMN IF NOT EXISTS connection_generation bigint,
  ADD COLUMN IF NOT EXISTS sync_run_id text,
  ADD COLUMN IF NOT EXISTS job_request_id text,
  ADD COLUMN IF NOT EXISTS queue_name text,
  ADD COLUMN IF NOT EXISTS message_id bigint,
  ADD COLUMN IF NOT EXISTS read_count integer;
ALTER TABLE control_plane.sync_write_permits
  ALTER COLUMN connection_generation SET NOT NULL,
  ALTER COLUMN sync_run_id SET NOT NULL,
  ALTER COLUMN job_request_id SET NOT NULL,
  ALTER COLUMN queue_name SET NOT NULL,
  ALTER COLUMN message_id SET NOT NULL,
  ALTER COLUMN read_count SET NOT NULL;
ALTER TABLE control_plane.sync_write_permits
  DROP CONSTRAINT IF EXISTS sync_write_permits_exact_lease_check;
ALTER TABLE control_plane.sync_write_permits
  ADD CONSTRAINT sync_write_permits_exact_lease_check CHECK(
    connection_generation>0 AND read_count>0
    AND queue_name IN ('albert_sync_high','albert_sync_standard','albert_sync_backfill')
  );
ALTER TABLE control_plane.sync_write_permits
  ADD CONSTRAINT sync_write_permits_sync_run_fk
  FOREIGN KEY(tenant_id,sync_run_id)
  REFERENCES control_plane.sync_runs(tenant_id,sync_run_id) ON DELETE CASCADE;
ALTER TABLE control_plane.sync_write_permits
  ADD CONSTRAINT sync_write_permits_job_request_fk
  FOREIGN KEY(tenant_id,job_request_id)
  REFERENCES control_plane.sync_job_requests(tenant_id,job_request_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX sync_write_permits_per_attempt
  ON control_plane.sync_write_permits(tenant_id,job_request_id,read_count);
CREATE UNIQUE INDEX sync_write_permits_global_id
  ON control_plane.sync_write_permits(permit_id);
ALTER TABLE control_plane.sync_write_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.sync_write_permits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS migration_owner_access ON control_plane.sync_write_permits;
CREATE POLICY migration_owner_access ON control_plane.sync_write_permits
  FOR ALL TO albert_control_migration_owner USING(true) WITH CHECK(true);

DROP FUNCTION IF EXISTS control_plane.acquire_sync_write_permit(text,text,text,text,integer);
CREATE FUNCTION control_plane.acquire_sync_write_permit(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_sync_run_id text,p_job_request_id text,p_queue_name text,p_message_id bigint,
  p_worker_id text,p_read_count integer,p_ttl_seconds integer DEFAULT 1200
) RETURNS TABLE(permit_id text,expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE generated_id text;deadline timestamptz;lease_tenant text;attempt_deadline timestamptz;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_sync_control_runtime','albert_sync_control'
  );
  lease_tenant:=control_plane.require_active_sync_job_lease(
    p_queue_name,p_message_id,p_job_request_id,p_worker_id,p_read_count
  );
  IF lease_tenant IS DISTINCT FROM p_tenant_id OR p_connection_generation<1
     OR p_ttl_seconds NOT BETWEEN 60 AND 1800 THEN
    RAISE EXCEPTION 'sync write permit lease identity is invalid' USING ERRCODE='22023';
  END IF;
  SELECT attempt.visibility_deadline INTO attempt_deadline
    FROM control_plane.sync_job_requests request
    JOIN control_plane.sync_job_attempts attempt
      ON attempt.tenant_id=request.tenant_id AND attempt.job_request_id=request.job_request_id
     AND attempt.attempt_number=p_read_count AND attempt.worker_id=p_worker_id
    JOIN control_plane.sync_runs run
      ON run.tenant_id=request.tenant_id AND run.sync_run_id=p_sync_run_id
    JOIN control_plane.connections connection
      ON connection.tenant_id=request.tenant_id AND connection.connection_id=request.connection_id
    JOIN control_plane.tenants tenant ON tenant.tenant_id=request.tenant_id
   WHERE request.tenant_id=p_tenant_id AND request.job_request_id=p_job_request_id
     AND request.connection_id=p_connection_id
     AND request.queue_name=p_queue_name AND request.queue_message_id=p_message_id
     AND request.status='running' AND run.status='running'
     AND run.connection_id=p_connection_id
     AND run.connection_generation=p_connection_generation
     AND connection.connection_generation=p_connection_generation
     AND connection.status IN ('connected','degraded') AND tenant.status='active'
     AND request.payload->>'tenantId'=p_tenant_id
     AND request.payload->>'connectionId'=p_connection_id
     AND request.payload->>'syncRunId'=p_sync_run_id
     AND (request.payload->>'connectionGeneration')::bigint=p_connection_generation
     AND NOT EXISTS(
       SELECT 1 FROM control_plane.deletion_requests deletion
       WHERE deletion.tenant_id=p_tenant_id
         AND (deletion.scope='tenant' OR deletion.connection_id=p_connection_id)
         AND deletion.status IN ('queued','running','retry_wait','verifying','failed')
     )
   FOR SHARE OF request,attempt,run,connection,tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync write permit is fenced by stale work or deletion' USING ERRCODE='55000';
  END IF;
  deadline:=least(clock_timestamp()+make_interval(secs=>p_ttl_seconds),attempt_deadline);
  IF deadline<=clock_timestamp()+interval '5 seconds' THEN
    RAISE EXCEPTION 'sync job visibility expires too soon for a write permit' USING ERRCODE='55000';
  END IF;
  generated_id:=control_plane.generate_ulid();
  INSERT INTO control_plane.sync_write_permits(
    tenant_id,permit_id,connection_id,connection_generation,sync_run_id,
    job_request_id,queue_name,message_id,read_count,worker_id,expires_at
  ) VALUES(
    p_tenant_id,generated_id,p_connection_id,p_connection_generation,p_sync_run_id,
    p_job_request_id,p_queue_name,p_message_id,p_read_count,p_worker_id,deadline
  ) ON CONFLICT(tenant_id,job_request_id,read_count) DO UPDATE SET
    expires_at=excluded.expires_at
  WHERE control_plane.sync_write_permits.worker_id=excluded.worker_id
    AND control_plane.sync_write_permits.connection_id=excluded.connection_id
    AND control_plane.sync_write_permits.connection_generation=excluded.connection_generation
    AND control_plane.sync_write_permits.sync_run_id=excluded.sync_run_id
  RETURNING control_plane.sync_write_permits.permit_id,
            control_plane.sync_write_permits.expires_at
       INTO permit_id,expires_at;
  IF permit_id IS NULL THEN
    RAISE EXCEPTION 'sync write permit ownership mismatch' USING ERRCODE='55000';
  END IF;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_sync_write_permit_and_issue_capability(
  p_permit_id text,p_worker_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE permit control_plane.sync_write_permits%ROWTYPE;lease_tenant text;attempt_deadline timestamptz;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_sync_control_runtime','albert_sync_control'
  );
  SELECT * INTO permit FROM control_plane.sync_write_permits candidate
   WHERE candidate.permit_id=p_permit_id AND candidate.worker_id=p_worker_id
     AND candidate.expires_at>clock_timestamp()
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync write permit is not active' USING ERRCODE='55000';
  END IF;
  lease_tenant:=control_plane.require_active_sync_job_lease(
    permit.queue_name,permit.message_id,permit.job_request_id,permit.worker_id,permit.read_count
  );
  SELECT attempt.visibility_deadline INTO attempt_deadline
    FROM control_plane.sync_job_requests request
    JOIN control_plane.sync_job_attempts attempt
      ON attempt.tenant_id=request.tenant_id AND attempt.job_request_id=request.job_request_id
     AND attempt.attempt_number=permit.read_count AND attempt.worker_id=permit.worker_id
    JOIN control_plane.sync_runs run
      ON run.tenant_id=permit.tenant_id AND run.sync_run_id=permit.sync_run_id
    JOIN control_plane.connections connection
      ON connection.tenant_id=permit.tenant_id AND connection.connection_id=permit.connection_id
    JOIN control_plane.tenants tenant ON tenant.tenant_id=permit.tenant_id
   WHERE request.tenant_id=permit.tenant_id AND request.job_request_id=permit.job_request_id
     AND request.status='running' AND request.queue_name=permit.queue_name
     AND request.queue_message_id=permit.message_id
     AND run.status='running' AND run.connection_id=permit.connection_id
     AND run.connection_generation=permit.connection_generation
     AND connection.connection_generation=permit.connection_generation
     AND connection.status IN ('connected','degraded') AND tenant.status='active'
     AND attempt.visibility_deadline>clock_timestamp() AND attempt.finished_at IS NULL
     AND NOT EXISTS(
       SELECT 1 FROM control_plane.sync_job_attempt_outcomes outcome
       WHERE outcome.tenant_id=attempt.tenant_id AND outcome.job_attempt_id=attempt.job_attempt_id
     )
     AND NOT EXISTS(
       SELECT 1 FROM control_plane.deletion_requests deletion
       WHERE deletion.tenant_id=permit.tenant_id
         AND (deletion.scope='tenant' OR deletion.connection_id=permit.connection_id)
         AND deletion.status IN ('queued','running','retry_wait','verifying','failed')
     )
   FOR SHARE OF request,attempt,run,connection,tenant;
  IF NOT FOUND OR lease_tenant IS DISTINCT FROM permit.tenant_id THEN
    RAISE EXCEPTION 'sync write permit is fenced by stale work or deletion' USING ERRCODE='55000';
  END IF;
  RETURN control_plane.sign_analytical_capability(
    permit.tenant_id,'analytical:ingest','ingest',
    'sync-job:'||permit.job_request_id||':attempt:'||permit.read_count,
    least(permit.expires_at,attempt_deadline),
    jsonb_build_object(
      'kind','sync_job','permit_id',permit.permit_id,
      'connection_id',permit.connection_id,
      'connection_generation',permit.connection_generation,
      'sync_run_id',permit.sync_run_id,'job_request_id',permit.job_request_id,
      'queue_name',permit.queue_name,'message_id',permit.message_id,
      'read_count',permit.read_count,'worker_id',permit.worker_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.release_sync_write_permit(
  p_tenant_id text,p_permit_id text,p_worker_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE removed_count bigint;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_sync_control_runtime','albert_sync_control'
  );
  DELETE FROM control_plane.sync_write_permits permit
   WHERE permit.tenant_id=p_tenant_id AND permit.permit_id=p_permit_id
     AND permit.worker_id=p_worker_id;
  GET DIAGNOSTICS removed_count=ROW_COUNT;
  RETURN removed_count>0;
END;
$$;

-- The reveal request is already one-use in the control plane.  Return a
-- diagnostic-role capability in the same claim response so tenant scope cannot
-- be substituted between the control and analytical calls.
ALTER FUNCTION control_plane.claim_operator_diagnostic_reveal(text)
  RENAME TO claim_operator_diagnostic_reveal_pre_capability;
REVOKE ALL ON FUNCTION control_plane.claim_operator_diagnostic_reveal_pre_capability(text)
  FROM PUBLIC,anon,authenticated,service_role,albert_operator_diagnostic_control;
CREATE FUNCTION control_plane.claim_operator_diagnostic_reveal(p_reveal_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE grant_record jsonb;capability text;deadline timestamptz;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_operator_diagnostic_control_runtime','albert_operator_diagnostic_control'
  );
  grant_record:=control_plane.claim_operator_diagnostic_reveal_pre_capability(p_reveal_id);
  deadline:=(grant_record->>'expires_at')::timestamptz;
  capability:=control_plane.sign_analytical_capability(
    grant_record->>'tenant_id','analytical:diagnostic','diagnostic',
    'diagnostic-reveal:'||p_reveal_id,deadline,
    jsonb_build_object(
      'kind','diagnostic_reveal','reveal_id',p_reveal_id,
      'schema_name',grant_record->>'schema_name','table_name',grant_record->>'table_name',
      'row_limit',(grant_record->>'row_limit')::integer
    )
  );
  RETURN grant_record||jsonb_build_object('analytical_capability',capability);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.issue_deletion_analytical_capability(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,p_read_count integer,
  p_operation text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE;attempt_deadline timestamptz;scope_name text;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_deletion_control_runtime','albert_deletion_control'
  );
  IF p_operation NOT IN ('purge','verify') THEN
    RAISE EXCEPTION 'deletion analytical operation is invalid' USING ERRCODE='22023';
  END IF;
  request_row:=control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  IF (p_operation='purge' AND request_row.status<>'running')
     OR (p_operation='verify' AND request_row.status<>'verifying') THEN
    RAISE EXCEPTION 'deletion lifecycle does not authorize this analytical operation'
      USING ERRCODE='55000';
  END IF;
  SELECT attempt.visibility_deadline INTO STRICT attempt_deadline
    FROM control_plane.deletion_job_attempts attempt
   WHERE attempt.tenant_id=request_row.tenant_id
     AND attempt.deletion_request_id=request_row.deletion_request_id
     AND attempt.attempt_number=p_read_count AND attempt.worker_id=p_worker_id
     AND attempt.outcome IS NULL
   FOR SHARE;
  scope_name:='deletion_'||p_operation;
  RETURN control_plane.sign_analytical_capability(
    request_row.tenant_id,'analytical:deletion',scope_name,
    'deletion-request:'||request_row.deletion_request_id||':attempt:'||p_read_count,
    attempt_deadline,
    jsonb_build_object(
      'kind','deletion_lease','operation',p_operation,
      'deletion_request_id',request_row.deletion_request_id,
      'message_id',p_message_id,'read_count',p_read_count,'worker_id',p_worker_id,
      'request_scope',request_row.scope,'connection_id',request_row.connection_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION control_plane.assert_analytical_capability_issuer_ready(),
  control_plane.issue_semantic_analytical_capability(text,text,text,text),
  control_plane.issue_transform_job_analytical_capability(text,text,text,text),
  control_plane.issue_identity_projection_analytical_capability(text,text,text,text),
  control_plane.claim_transform_maintenance_leases(text,integer),
  control_plane.complete_transform_maintenance(text,text,text),
  control_plane.issue_transform_maintenance_analytical_capability(text,text,text),
  control_plane.acquire_sync_write_permit(text,text,bigint,text,text,text,bigint,text,integer,integer),
  control_plane.assert_sync_write_permit_and_issue_capability(text,text),
  control_plane.release_sync_write_permit(text,text,text),
  control_plane.claim_operator_diagnostic_reveal(text),
  control_plane.issue_deletion_analytical_capability(bigint,text,text,integer,text)
  FROM PUBLIC,anon,authenticated,service_role,albert_webhook_control;

GRANT EXECUTE ON FUNCTION control_plane.assert_analytical_capability_issuer_ready()
  TO albert_sync_control,albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;
GRANT EXECUTE ON FUNCTION control_plane.issue_semantic_analytical_capability(text,text,text,text)
  TO albert_semantic_control;
GRANT EXECUTE ON FUNCTION control_plane.issue_transform_job_analytical_capability(text,text,text,text),
  control_plane.issue_identity_projection_analytical_capability(text,text,text,text),
  control_plane.claim_transform_maintenance_leases(text,integer),
  control_plane.complete_transform_maintenance(text,text,text),
  control_plane.issue_transform_maintenance_analytical_capability(text,text,text)
  TO albert_transform_control;
GRANT EXECUTE ON FUNCTION
  control_plane.acquire_sync_write_permit(text,text,bigint,text,text,text,bigint,text,integer,integer),
  control_plane.assert_sync_write_permit_and_issue_capability(text,text),
  control_plane.release_sync_write_permit(text,text,text)
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.claim_operator_diagnostic_reveal(text)
  TO albert_operator_diagnostic_control;
GRANT EXECUTE ON FUNCTION control_plane.issue_deletion_analytical_capability(bigint,text,text,integer,text)
  TO albert_deletion_control;

COMMIT;
