BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.canonical_transform_job_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.canonical_transform_job_status_lookup (status,description) VALUES
  ('queued','Typed staging is committed and canonical transformation is waiting to run'),
  ('running','A transform worker holds the active fenced lease'),
  ('retry_wait','A retryable transform failure is waiting for its backoff'),
  ('succeeded','Canonical, quality, mart and control-plane projections completed'),
  ('failed','Canonical transformation exhausted retries or failed permanently')
ON CONFLICT (status) DO UPDATE SET description=excluded.description;

CREATE TABLE IF NOT EXISTS control_plane.canonical_transform_jobs (
  tenant_id text NOT NULL,
  transform_job_id text NOT NULL CHECK (control_plane.is_ulid(transform_job_id)),
  batch_id text NOT NULL,
  sync_run_id text NOT NULL,
  connection_id text NOT NULL,
  connector_id text NOT NULL CHECK (connector_id IN ('lightspeed-r','xero','deputy')),
  stream text NOT NULL CHECK (length(btrim(stream))>0),
  domains text[] NOT NULL CHECK (cardinality(domains)>0),
  mapping_version text NOT NULL CHECK (mapping_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  backfill_complete boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued'
    REFERENCES control_plane.canonical_transform_job_status_lookup(status),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text CHECK (lease_owner IS NULL OR length(btrim(lease_owner)) BETWEEN 1 AND 160),
  lease_token text CHECK (lease_token IS NULL OR control_plane.is_ulid(lease_token)),
  lease_expires_at timestamptz,
  last_error jsonb,
  result_metadata jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,transform_job_id),
  UNIQUE (tenant_id,batch_id,mapping_version),
  FOREIGN KEY (tenant_id,batch_id)
    REFERENCES control_plane.raw_batch_landings(tenant_id,batch_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,sync_run_id)
    REFERENCES control_plane.sync_runs(tenant_id,sync_run_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id) ON DELETE CASCADE,
  CHECK (last_error IS NULL OR jsonb_typeof(last_error)='object'),
  CHECK (result_metadata IS NULL OR jsonb_typeof(result_metadata)='object'),
  CHECK ((lease_owner IS NULL)=(lease_token IS NULL)),
  CHECK ((lease_owner IS NULL)=(lease_expires_at IS NULL)),
  CHECK (completed_at IS NULL OR completed_at>=created_at)
);

CREATE INDEX IF NOT EXISTS canonical_transform_jobs_claim_idx
  ON control_plane.canonical_transform_jobs (mapping_version,available_at,created_at)
  WHERE status IN ('queued','retry_wait','running');

ALTER TABLE control_plane.canonical_transform_jobs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.enqueue_canonical_transform_job(
  p_tenant_id text,
  p_batch_id text,
  p_mapping_version text,
  p_domains text[],
  p_backfill_complete boolean
) RETURNS TABLE (transform_job_id text,created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE manifest_row record; existing_id text; generated_id text;
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_batch_id)
     OR p_mapping_version IS NULL
     OR p_mapping_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR p_domains IS NULL OR cardinality(p_domains)=0
     OR EXISTS (
       SELECT 1 FROM unnest(p_domains) AS domain(value)
       WHERE value !~ '^[a-z][a-z0-9_]*$'
     ) THEN
    RAISE EXCEPTION 'canonical transform enqueue input is invalid' USING ERRCODE='22023';
  END IF;

  SELECT manifest.tenant_id,manifest.batch_id,manifest.sync_run_id,
         manifest.connection_id,manifest.connector_key,manifest.stream
    INTO manifest_row
    FROM control_plane.raw_batch_manifests AS manifest
    JOIN control_plane.raw_batch_landings AS landing
      ON landing.tenant_id=manifest.tenant_id AND landing.batch_id=manifest.batch_id
   WHERE manifest.tenant_id=p_tenant_id AND manifest.batch_id=p_batch_id
     AND landing.status IN ('landed','quarantined')
     AND landing.analytical_committed_at IS NOT NULL
   FOR UPDATE OF landing;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical transform batch is not durably landed' USING ERRCODE='55000';
  END IF;

  SELECT job.transform_job_id INTO existing_id
    FROM control_plane.canonical_transform_jobs AS job
   WHERE job.tenant_id=p_tenant_id AND job.batch_id=p_batch_id
     AND job.mapping_version=p_mapping_version;
  IF existing_id IS NOT NULL THEN
    RETURN QUERY SELECT existing_id,false;
    RETURN;
  END IF;

  generated_id:=control_plane.generate_ulid();
  INSERT INTO control_plane.canonical_transform_jobs (
    tenant_id,transform_job_id,batch_id,sync_run_id,connection_id,connector_id,
    stream,domains,mapping_version,backfill_complete
  ) VALUES (
    manifest_row.tenant_id,generated_id,manifest_row.batch_id,manifest_row.sync_run_id,
    manifest_row.connection_id,manifest_row.connector_key,manifest_row.stream,
    ARRAY(SELECT DISTINCT value FROM unnest(p_domains) AS domain(value) ORDER BY value),
    p_mapping_version,p_backfill_complete
  );
  RETURN QUERY SELECT generated_id,true;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.claim_canonical_transform_job(
  p_worker_id text,
  p_mapping_version text,
  p_lease_seconds integer
) RETURNS TABLE (
  tenant_id text,transform_job_id text,batch_id text,sync_run_id text,
  connection_id text,connector_id text,stream text,domains text[],
  mapping_version text,backfill_complete boolean,attempt_count integer,
  lease_token text,lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_mapping_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'canonical transform claim input is invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT job.tenant_id,job.transform_job_id
      FROM control_plane.canonical_transform_jobs AS job
     WHERE job.mapping_version=p_mapping_version
       AND job.available_at<=now()
       AND (
         job.status IN ('queued','retry_wait')
         OR (job.status='running' AND job.lease_expires_at<now())
       )
     ORDER BY job.available_at,job.created_at,job.transform_job_id
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE control_plane.canonical_transform_jobs AS job
     SET status='running',attempt_count=job.attempt_count+1,
         lease_owner=p_worker_id,lease_token=control_plane.generate_ulid(),
         lease_expires_at=now()+pg_catalog.make_interval(secs=>p_lease_seconds),
         started_at=coalesce(job.started_at,now()),completed_at=NULL,
         last_error=NULL,updated_at=now()
    FROM candidate
   WHERE job.tenant_id=candidate.tenant_id
     AND job.transform_job_id=candidate.transform_job_id
  RETURNING job.tenant_id,job.transform_job_id,job.batch_id,job.sync_run_id,
            job.connection_id,job.connector_id,job.stream,job.domains,
            job.mapping_version,job.backfill_complete,job.attempt_count,
            job.lease_token,job.lease_expires_at;
  UPDATE control_plane.readiness AS readiness
     SET state='validating',progress=greatest(coalesce(readiness.progress,0),0.75),
         reason_code=NULL,reason_detail=NULL,evaluated_at=now(),updated_at=now()
    FROM control_plane.canonical_transform_jobs AS job
   WHERE job.lease_owner=p_worker_id AND job.status='running'
     AND job.lease_expires_at>now()
     AND readiness.tenant_id=job.tenant_id
     AND readiness.connection_id=job.connection_id
     AND readiness.domain=ANY(job.domains);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.extend_canonical_transform_lease(
  p_tenant_id text,p_transform_job_id text,p_worker_id text,p_lease_token text,p_lease_seconds integer
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE deadline timestamptz;
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'canonical transform lease duration is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.canonical_transform_jobs AS job
     SET lease_expires_at=now()+pg_catalog.make_interval(secs=>p_lease_seconds),updated_at=now()
   WHERE job.tenant_id=p_tenant_id AND job.transform_job_id=p_transform_job_id
     AND job.status='running' AND job.lease_owner=p_worker_id
     AND job.lease_token=p_lease_token AND job.lease_expires_at>now()
  RETURNING job.lease_expires_at INTO deadline;
  IF deadline IS NULL THEN
    RAISE EXCEPTION 'canonical transform lease is stale' USING ERRCODE='55000';
  END IF;
  RETURN deadline;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_canonical_transform_job(
  p_tenant_id text,p_transform_job_id text,p_worker_id text,p_lease_token text,p_result jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' THEN
    RAISE EXCEPTION 'canonical transform result must be an object' USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.canonical_transform_jobs AS job
     SET status='succeeded',result_metadata=p_result,completed_at=now(),
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE job.tenant_id=p_tenant_id AND job.transform_job_id=p_transform_job_id
     AND job.status='running' AND job.lease_owner=p_worker_id
     AND job.lease_token=p_lease_token AND job.lease_expires_at>now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical transform lease is stale' USING ERRCODE='55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.retry_or_fail_canonical_transform_job(
  p_tenant_id text,p_transform_job_id text,p_worker_id text,p_lease_token text,
  p_error jsonb,p_retry_delay_seconds integer,p_max_attempts integer
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE next_status text;
BEGIN
  IF p_error IS NULL OR jsonb_typeof(p_error)<>'object'
     OR p_retry_delay_seconds NOT BETWEEN 1 AND 86400
     OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'canonical transform failure input is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.canonical_transform_jobs AS job
     SET status=CASE WHEN job.attempt_count>=p_max_attempts OR coalesce((p_error->>'retryable')::boolean,false)=false THEN 'failed' ELSE 'retry_wait' END,
         available_at=CASE WHEN job.attempt_count>=p_max_attempts OR coalesce((p_error->>'retryable')::boolean,false)=false THEN job.available_at ELSE now()+pg_catalog.make_interval(secs=>p_retry_delay_seconds) END,
         last_error=p_error,
         completed_at=CASE WHEN job.attempt_count>=p_max_attempts OR coalesce((p_error->>'retryable')::boolean,false)=false THEN now() ELSE NULL END,
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE job.tenant_id=p_tenant_id AND job.transform_job_id=p_transform_job_id
     AND job.status='running' AND job.lease_owner=p_worker_id
     AND job.lease_token=p_lease_token AND job.lease_expires_at>now()
  RETURNING job.status INTO next_status;
  IF next_status IS NULL THEN
    RAISE EXCEPTION 'canonical transform lease is stale' USING ERRCODE='55000';
  END IF;
  IF next_status='failed' THEN
    UPDATE control_plane.readiness AS readiness
       SET state='blocked',reason_code='canonical_transform_failed',
           reason_detail=left(coalesce(p_error->>'detail','Canonical transformation failed.'),500),
           evaluated_at=now(),updated_at=now()
      FROM control_plane.canonical_transform_jobs AS job
     WHERE job.tenant_id=p_tenant_id AND job.transform_job_id=p_transform_job_id
       AND readiness.tenant_id=job.tenant_id
       AND readiness.connection_id=job.connection_id
       AND readiness.domain=ANY(job.domains);
  END IF;
  RETURN next_status;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.canonical_transform_queue_metrics()
RETURNS TABLE (status text,job_count bigint,oldest_age_seconds bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
  SELECT job.status,count(*)::bigint,
         extract(epoch FROM now()-min(job.created_at))::bigint
    FROM control_plane.canonical_transform_jobs AS job
   GROUP BY job.status ORDER BY job.status
$$;

CREATE OR REPLACE FUNCTION control_plane.canonical_transform_tenant_watermarks()
RETURNS TABLE (tenant_id text,source_watermarks jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
  SELECT connection.tenant_id,
         coalesce(
           jsonb_object_agg(connection.connection_id,watermark.source_watermark)
             FILTER (WHERE watermark.source_watermark IS NOT NULL),
           '{}'::jsonb
         ) AS source_watermarks
    FROM control_plane.connections AS connection
    LEFT JOIN LATERAL (
      SELECT max(cursor.source_watermark) AS source_watermark
        FROM control_plane.stream_cursors AS cursor
       WHERE cursor.tenant_id=connection.tenant_id
         AND cursor.connection_id=connection.connection_id
    ) AS watermark ON true
   WHERE connection.status IN ('connected','degraded')
   GROUP BY connection.tenant_id
   ORDER BY connection.tenant_id
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_transform_control_boundary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  login_role name:=session_user;
  login_oid oid;
  privileged boolean;
  forbidden_table text;
BEGIN
  SELECT role.oid,
         role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
           OR role.rolreplication OR role.rolbypassrls
    INTO login_oid,privileged
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname=login_role;
  IF login_oid IS NULL OR privileged
     OR NOT pg_catalog.pg_has_role(login_role,'albert_transform_control','member') THEN
    RAISE EXCEPTION 'transform control login is over-privileged or lacks its required role'
      USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid=membership.roleid
     WHERE membership.member=login_oid
       AND granted_role.rolname<>'albert_transform_control'
  ) THEN
    RAISE EXCEPTION 'transform control login must be a member only of albert_transform_control'
      USING ERRCODE='42501';
  END IF;
  FOREACH forbidden_table IN ARRAY ARRAY[
    'control_plane.oauth_token_refs',
    'control_plane.raw_batch_manifests',
    'control_plane.raw_batch_landings',
    'control_plane.sync_job_requests',
    'control_plane.canonical_transform_jobs',
    'control_plane.worker_heartbeats'
  ] LOOP
    IF pg_catalog.has_table_privilege(login_role,forbidden_table,'SELECT')
       OR pg_catalog.has_table_privilege(login_role,forbidden_table,'INSERT')
       OR pg_catalog.has_table_privilege(login_role,forbidden_table,'UPDATE')
       OR pg_catalog.has_table_privilege(login_role,forbidden_table,'DELETE') THEN
      RAISE EXCEPTION 'transform control login has forbidden direct table privilege on %',forbidden_table
        USING ERRCODE='42501';
    END IF;
  END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS control_plane.pipeline_stats (
  tenant_id text NOT NULL,
  snapshot_at timestamptz NOT NULL,
  schema_name text NOT NULL CHECK (schema_name IN ('source_lightspeed','source_xero','source_deputy','core','mart')),
  table_name text NOT NULL CHECK (table_name ~ '^[a-z_][a-z0-9_]*$'),
  row_count bigint NOT NULL CHECK (row_count>=0),
  max_event_at timestamptz,
  max_ingested_at timestamptz,
  invariant_status jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(invariant_status)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,snapshot_at,schema_name,table_name),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pipeline_stats_tenant_latest_idx
  ON control_plane.pipeline_stats (tenant_id,snapshot_at DESC,schema_name,table_name);

ALTER TABLE control_plane.pipeline_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_members_read ON control_plane.pipeline_stats;
CREATE POLICY tenant_members_read ON control_plane.pipeline_stats FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS transform_control_scope ON control_plane.connections;
CREATE POLICY transform_control_scope ON control_plane.connections
  FOR SELECT TO albert_transform_control
  USING (tenant_id=nullif(current_setting('albert.tenant_id',true),''));
DROP POLICY IF EXISTS transform_control_scope ON control_plane.tenant_overlays;
CREATE POLICY transform_control_scope ON control_plane.tenant_overlays
  FOR SELECT TO albert_transform_control
  USING (tenant_id=nullif(current_setting('albert.tenant_id',true),''));
DROP POLICY IF EXISTS transform_control_scope ON control_plane.dossiers;
CREATE POLICY transform_control_scope ON control_plane.dossiers
  FOR SELECT TO albert_transform_control
  USING (tenant_id=nullif(current_setting('albert.tenant_id',true),''));
DROP POLICY IF EXISTS transform_control_scope ON control_plane.stream_cursors;
CREATE POLICY transform_control_scope ON control_plane.stream_cursors
  FOR SELECT TO albert_transform_control
  USING (tenant_id=nullif(current_setting('albert.tenant_id',true),''));
DROP POLICY IF EXISTS transform_control_scope ON control_plane.readiness;
CREATE POLICY transform_control_scope ON control_plane.readiness
  FOR ALL TO albert_transform_control
  USING (tenant_id=nullif(current_setting('albert.tenant_id',true),''))
  WITH CHECK (tenant_id=nullif(current_setting('albert.tenant_id',true),''));
DROP POLICY IF EXISTS transform_control_scope ON control_plane.identity_review_tasks;
CREATE POLICY transform_control_scope ON control_plane.identity_review_tasks
  FOR ALL TO albert_transform_control
  USING (tenant_id=nullif(current_setting('albert.tenant_id',true),''))
  WITH CHECK (tenant_id=nullif(current_setting('albert.tenant_id',true),''));
DROP POLICY IF EXISTS transform_control_scope ON control_plane.pipeline_stats;
CREATE POLICY transform_control_scope ON control_plane.pipeline_stats
  FOR ALL TO albert_transform_control
  USING (tenant_id=nullif(current_setting('albert.tenant_id',true),''))
  WITH CHECK (tenant_id=nullif(current_setting('albert.tenant_id',true),''));

CREATE UNIQUE INDEX IF NOT EXISTS identity_review_tasks_suggestion_key_idx
  ON control_plane.identity_review_tasks (tenant_id,(evidence->>'suggestion_key'))
  WHERE evidence ? 'suggestion_key';

CREATE OR REPLACE FUNCTION public.albert_operator_pipeline_stats(p_tenant_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=auth.uid(); result jsonb;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control_plane.tenants WHERE tenant_id=p_tenant_id) THEN
    RAISE EXCEPTION 'tenant was not found' USING ERRCODE='P0002';
  END IF;
  INSERT INTO control_plane.operator_audit_log (operator_audit_id,actor_user_id,action,target_tenant_id,request_metadata)
  VALUES (control_plane.generate_ulid(),actor,'operator.pipeline_stats_read',p_tenant_id,'{}'::jsonb);
  SELECT coalesce(jsonb_agg(to_jsonb(stat) ORDER BY stat.schema_name,stat.table_name),'[]'::jsonb) INTO result
  FROM (
    SELECT DISTINCT ON (schema_name,table_name) tenant_id,snapshot_at,schema_name,table_name,row_count,max_event_at,max_ingested_at,invariant_status
    FROM control_plane.pipeline_stats WHERE tenant_id=p_tenant_id
    ORDER BY schema_name,table_name,snapshot_at DESC
  ) stat;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.albert_operator_transform_jobs(p_tenant_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=auth.uid(); result jsonb;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control_plane.tenants WHERE tenant_id=p_tenant_id) THEN
    RAISE EXCEPTION 'tenant was not found' USING ERRCODE='P0002';
  END IF;
  INSERT INTO control_plane.operator_audit_log (operator_audit_id,actor_user_id,action,target_tenant_id,request_metadata)
  VALUES (control_plane.generate_ulid(),actor,'operator.transform_jobs_read',p_tenant_id,'{}'::jsonb);
  SELECT coalesce(jsonb_agg(to_jsonb(job) ORDER BY job.created_at DESC),'[]'::jsonb) INTO result
    FROM (
      SELECT transform_job_id,batch_id,sync_run_id,connection_id,connector_id,
             stream,domains,mapping_version,backfill_complete,status,attempt_count,
             available_at,lease_expires_at,
             CASE WHEN last_error IS NULL THEN NULL ELSE last_error->>'code' END AS last_error_code,
             result_metadata,started_at,completed_at,created_at,updated_at
        FROM control_plane.canonical_transform_jobs
       WHERE tenant_id=p_tenant_id
       ORDER BY created_at DESC LIMIT 100
    ) AS job;
  RETURN result;
END $$;

REVOKE ALL ON control_plane.pipeline_stats FROM PUBLIC,anon,service_role;
REVOKE ALL ON control_plane.canonical_transform_job_status_lookup,
  control_plane.canonical_transform_jobs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON control_plane.pipeline_stats TO authenticated;
GRANT USAGE ON SCHEMA control_plane TO albert_transform_control;
GRANT SELECT (tenant_id,connection_id,connector_key,status,account_metadata)
  ON control_plane.connections TO albert_transform_control;
GRANT SELECT (tenant_id,status,version,overlay)
  ON control_plane.tenant_overlays TO albert_transform_control;
GRANT SELECT (tenant_id,status,version,content)
  ON control_plane.dossiers TO albert_transform_control;
GRANT SELECT (tenant_id,connection_id,stream,backfill_complete,source_watermark)
  ON control_plane.stream_cursors TO albert_transform_control;
GRANT SELECT,INSERT,UPDATE ON control_plane.readiness,
  control_plane.identity_review_tasks,control_plane.pipeline_stats TO albert_transform_control;
REVOKE ALL ON FUNCTION control_plane.enqueue_canonical_transform_job(text,text,text,text[],boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.claim_canonical_transform_job(text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.extend_canonical_transform_lease(text,text,text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.complete_canonical_transform_job(text,text,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.retry_or_fail_canonical_transform_job(text,text,text,text,jsonb,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.canonical_transform_queue_metrics() FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.canonical_transform_tenant_watermarks() FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.assert_transform_control_boundary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control_plane.enqueue_canonical_transform_job(text,text,text,text[],boolean) TO service_role;
GRANT EXECUTE ON FUNCTION control_plane.claim_canonical_transform_job(text,text,integer),
  control_plane.extend_canonical_transform_lease(text,text,text,text,integer),
  control_plane.complete_canonical_transform_job(text,text,text,text,jsonb),
  control_plane.retry_or_fail_canonical_transform_job(text,text,text,text,jsonb,integer,integer),
  control_plane.canonical_transform_queue_metrics(),
  control_plane.canonical_transform_tenant_watermarks(),
  control_plane.assert_transform_control_boundary(),
  control_plane.heartbeat_worker(text,text,text,timestamptz,integer,jsonb)
TO albert_transform_control;
REVOKE ALL ON FUNCTION public.albert_operator_pipeline_stats(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_operator_transform_jobs(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_operator_pipeline_stats(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_operator_transform_jobs(text) TO authenticated;

COMMIT;
