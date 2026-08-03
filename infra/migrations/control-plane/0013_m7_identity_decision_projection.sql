BEGIN;

-- Human identity decisions are control-plane commands.  They must cross the
-- database boundary through a durable, leased outbox; the browser and the
-- control-plane runtime never receive analytical credentials.
CREATE TABLE IF NOT EXISTS control_plane.identity_decision_projection_outbox (
  tenant_id text NOT NULL,
  projection_id text NOT NULL CHECK (control_plane.is_ulid(projection_id)),
  decision_id text NOT NULL,
  identity_review_task_id text NOT NULL,
  decision_version integer NOT NULL CHECK (decision_version > 0),
  decision text NOT NULL CHECK (decision IN ('accepted','rejected','proposed')),
  entity_type text NOT NULL CHECK (entity_type IN ('worker','location','product_variant','customer_account','supplier')),
  candidate_links jsonb NOT NULL CHECK (
    jsonb_typeof(candidate_links)='array'
    AND jsonb_array_length(candidate_links)=2
  ),
  decided_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry_wait','succeeded','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token text CHECK (lease_token IS NULL OR control_plane.is_ulid(lease_token)),
  lease_expires_at timestamptz,
  last_error jsonb CHECK (last_error IS NULL OR jsonb_typeof(last_error)='object'),
  result_metadata jsonb CHECK (result_metadata IS NULL OR jsonb_typeof(result_metadata)='object'),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,projection_id),
  UNIQUE (tenant_id,decision_id),
  UNIQUE (tenant_id,identity_review_task_id,decision_version),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,decision_id)
    REFERENCES control_plane.identity_review_decisions(tenant_id,decision_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,identity_review_task_id)
    REFERENCES control_plane.identity_review_tasks(tenant_id,identity_review_task_id) ON DELETE CASCADE,
  CHECK (
    (status='running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status<>'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS identity_decision_projection_claim_idx
  ON control_plane.identity_decision_projection_outbox
  (available_at,decided_at,projection_id)
  WHERE status IN ('queued','retry_wait','running');

ALTER TABLE control_plane.identity_decision_projection_outbox ENABLE ROW LEVEL SECURITY;

-- Existing installations may already have the M1 workspace RPC.  Replace it
-- here so completed cards remain visible for undo and projection state is not
-- hidden from the browser.
CREATE OR REPLACE FUNCTION public.albert_connections_workspace()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'tenant_id', tenant.tenant_id,
    'tenant_name', tenant.display_name,
    'connections', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'connection_id', connection.connection_id,
        'connector_key', connection.connector_key,
        'display_name', connection.display_name,
        'status', connection.status,
        'auth_health', connection.auth_health,
        'authorised_at', connection.authorised_at,
        'last_checked_at', connection.last_checked_at,
        'readiness', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'domain', readiness.domain,
            'state', readiness.state,
            'progress', readiness.progress,
            'data_ready_through', readiness.data_ready_through,
            'backfill_complete', readiness.backfill_complete,
            'reason_code', readiness.reason_code
          ) ORDER BY readiness.domain)
          FROM control_plane.readiness AS readiness
          WHERE readiness.tenant_id = selected_tenant
            AND readiness.connection_id = connection.connection_id
        ), '[]'::jsonb)
      ) ORDER BY connection.created_at)
      FROM control_plane.connections AS connection
      WHERE connection.tenant_id = selected_tenant
    ), '[]'::jsonb),
    'dossier', (
      SELECT jsonb_build_object(
        'version', dossier.version,
        'content', dossier.content,
        'provenance', dossier.provenance,
        'published_at', dossier.published_at
      )
      FROM control_plane.dossiers AS dossier
      WHERE dossier.tenant_id = selected_tenant
        AND dossier.status = 'published'
      LIMIT 1
    ),
    'identity_review_tasks', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'task_id', task.identity_review_task_id,
        'entity_type', task.entity_type,
        'status', task.status,
        'confidence_band', task.confidence_band,
        'candidate_links', task.candidate_links,
        'evidence', task.evidence,
        'resolution', task.resolution
      ) ORDER BY task.created_at)
      FROM control_plane.identity_review_tasks AS task
      WHERE task.tenant_id = selected_tenant
    ), '[]'::jsonb),
    'blocking_answers', coalesce((
      SELECT overlay.overlay -> 'blocking_answers'
      FROM control_plane.tenant_overlays AS overlay
      WHERE overlay.tenant_id = selected_tenant
        AND overlay.status = 'published'
      LIMIT 1
    ), '{}'::jsonb),
    'oauth_sessions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'oauth_session_id', session.oauth_session_id,
        'provider', session.provider,
        'status', session.status,
        'discovered_account_choices', session.discovered_account_choices,
        'expires_at', session.expires_at
      ) ORDER BY session.created_at DESC)
      FROM control_plane.oauth_sessions AS session
      WHERE session.tenant_id = selected_tenant
        AND session.initiated_by = auth.uid()
        AND session.status IN ('pending', 'selecting_account', 'exchanging')
        AND session.expires_at > now()
    ), '[]'::jsonb)
  ) INTO result
  FROM control_plane.tenants AS tenant
  WHERE tenant.tenant_id = selected_tenant;
  RETURN result;
END;
$$;

-- Replace the user RPC so recording the decision and publishing its immutable
-- projection command are one transaction.  A successful HTTP response can
-- never leave a decision with no data-plane work item.
CREATE OR REPLACE FUNCTION public.albert_decide_identity_match(
  p_task_id text,
  p_decision text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  task control_plane.identity_review_tasks%ROWTYPE;
  prior_decision text;
  next_version integer;
  generated_decision_id text;
  generated_projection_id text;
  decision_time timestamptz := clock_timestamp();
BEGIN
  IF NOT control_plane.has_tenant_role(selected_tenant, ARRAY['owner', 'manager']::text[]) THEN
    RAISE EXCEPTION 'owner or manager role required' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('accepted', 'rejected', 'proposed') THEN
    RAISE EXCEPTION 'decision must be accepted, rejected, or proposed' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO task
  FROM control_plane.identity_review_tasks AS candidate
  WHERE candidate.tenant_id = selected_tenant
    AND candidate.identity_review_task_id = p_task_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'identity review task was not found' USING ERRCODE = 'P0002';
  END IF;
  IF task.entity_type NOT IN ('worker','location','product_variant','customer_account','supplier')
     OR jsonb_typeof(task.candidate_links)<>'array'
     OR jsonb_array_length(task.candidate_links)<>2 THEN
    RAISE EXCEPTION 'identity review task is not projectable' USING ERRCODE='22023';
  END IF;

  SELECT decision.decision_id, decision.decision_version + 1
    INTO prior_decision, next_version
  FROM control_plane.identity_review_decisions AS decision
  WHERE decision.tenant_id = selected_tenant
    AND decision.identity_review_task_id = p_task_id
  ORDER BY decision.decision_version DESC
  LIMIT 1;
  next_version := coalesce(next_version, 1);
  generated_decision_id := control_plane.generate_ulid();
  generated_projection_id := control_plane.generate_ulid();

  INSERT INTO control_plane.identity_review_decisions (
    tenant_id, decision_id, identity_review_task_id, decision_version,
    decision, previous_decision_id, decided_by, decided_at
  ) VALUES (
    selected_tenant, generated_decision_id, p_task_id, next_version,
    p_decision, prior_decision, actor, decision_time
  );

  INSERT INTO control_plane.identity_decision_projection_outbox (
    tenant_id,projection_id,decision_id,identity_review_task_id,
    decision_version,decision,entity_type,candidate_links,decided_by,decided_at
  ) VALUES (
    selected_tenant,generated_projection_id,generated_decision_id,p_task_id,
    next_version,p_decision,task.entity_type,task.candidate_links,actor,decision_time
  );

  UPDATE control_plane.identity_review_tasks
  SET status = p_decision,
      resolved_by = CASE WHEN p_decision = 'proposed' THEN NULL ELSE actor END,
      resolution = jsonb_build_object(
        'decision',p_decision,
        'version',next_version,
        'decision_id',generated_decision_id,
        'projection_status','pending'
      ),
      resolved_at = CASE WHEN p_decision = 'proposed' THEN NULL ELSE decision_time END,
      updated_at = decision_time
  WHERE tenant_id = selected_tenant
    AND identity_review_task_id = p_task_id;

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'identity.match_decided', 'identity_review_task', p_task_id,
    jsonb_build_object(
      'decision',p_decision,
      'decision_version',next_version,
      'decision_id',generated_decision_id,
      'projection_id',generated_projection_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.claim_identity_decision_projection(
  p_worker_id text,
  p_lease_seconds integer
)
RETURNS TABLE (
  tenant_id text,
  projection_id text,
  decision_id text,
  identity_review_task_id text,
  decision_version integer,
  decision text,
  entity_type text,
  candidate_links jsonb,
  decided_by uuid,
  decided_at timestamptz,
  attempt_count integer,
  lease_token text,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'identity projection claim input is invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT item.tenant_id,item.projection_id
      FROM control_plane.identity_decision_projection_outbox AS item
     WHERE item.available_at<=now()
       AND (
         item.status IN ('queued','retry_wait')
         OR (item.status='running' AND item.lease_expires_at<now())
       )
       -- Decisions for one review task are a versioned command stream.  A
       -- later undo must never overtake an earlier confirmation retry.
       AND NOT EXISTS (
         SELECT 1
           FROM control_plane.identity_decision_projection_outbox AS earlier
          WHERE earlier.tenant_id=item.tenant_id
            AND earlier.identity_review_task_id=item.identity_review_task_id
            AND earlier.decision_version<item.decision_version
            AND earlier.status IN ('queued','running','retry_wait')
       )
     ORDER BY item.decided_at,item.decision_version,item.projection_id
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE control_plane.identity_decision_projection_outbox AS item
     SET status='running',attempt_count=item.attempt_count+1,
         lease_owner=p_worker_id,lease_token=control_plane.generate_ulid(),
         lease_expires_at=now()+pg_catalog.make_interval(secs=>p_lease_seconds),
         completed_at=NULL,last_error=NULL,updated_at=now()
    FROM candidate
   WHERE item.tenant_id=candidate.tenant_id AND item.projection_id=candidate.projection_id
  RETURNING item.tenant_id,item.projection_id,item.decision_id,item.identity_review_task_id,
            item.decision_version,item.decision,item.entity_type,item.candidate_links,
            item.decided_by,item.decided_at,item.attempt_count,item.lease_token,item.lease_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_identity_decision_projection(
  p_tenant_id text,
  p_projection_id text,
  p_worker_id text,
  p_lease_token text,
  p_result jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE projected control_plane.identity_decision_projection_outbox%ROWTYPE;
BEGIN
  IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' THEN
    RAISE EXCEPTION 'identity projection result must be an object' USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.identity_decision_projection_outbox AS item
     SET status='succeeded',result_metadata=p_result,completed_at=now(),
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE item.tenant_id=p_tenant_id AND item.projection_id=p_projection_id
     AND item.status='running' AND item.lease_owner=p_worker_id
     AND item.lease_token=p_lease_token AND item.lease_expires_at>now()
  RETURNING item.* INTO projected;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'identity projection lease is stale' USING ERRCODE='55000';
  END IF;

  UPDATE control_plane.identity_review_tasks AS task
     SET resolution=task.resolution||jsonb_build_object(
           'projection_status','applied','projected_at',now(),'projection_id',p_projection_id
         ),
         updated_at=now()
   WHERE task.tenant_id=projected.tenant_id
     AND task.identity_review_task_id=projected.identity_review_task_id
     AND (task.resolution->>'decision_id')=projected.decision_id;

  INSERT INTO control_plane.audit_log (
    tenant_id,audit_id,actor_type,action,resource_type,resource_id,audit_metadata
  ) VALUES (
    projected.tenant_id,control_plane.generate_ulid(),'service',
    'identity.match_projection_applied','identity_review_task',projected.identity_review_task_id,
    jsonb_build_object(
      'decision_id',projected.decision_id,
      'decision_version',projected.decision_version,
      'projection_id',projected.projection_id,
      'result',p_result
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.fail_identity_decision_projection(
  p_tenant_id text,
  p_projection_id text,
  p_worker_id text,
  p_lease_token text,
  p_error jsonb,
  p_retry_delay_seconds integer,
  p_max_attempts integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE next_status text; projected control_plane.identity_decision_projection_outbox%ROWTYPE;
BEGIN
  IF p_error IS NULL OR jsonb_typeof(p_error)<>'object'
     OR p_retry_delay_seconds NOT BETWEEN 1 AND 3600
     OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'identity projection failure input is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.identity_decision_projection_outbox AS item
     SET status=CASE
           WHEN item.attempt_count>=p_max_attempts OR coalesce((p_error->>'retryable')::boolean,true)=false
             THEN 'failed' ELSE 'retry_wait' END,
         available_at=CASE
           WHEN item.attempt_count>=p_max_attempts OR coalesce((p_error->>'retryable')::boolean,true)=false
             THEN item.available_at ELSE now()+pg_catalog.make_interval(secs=>p_retry_delay_seconds) END,
         last_error=p_error,
         completed_at=CASE
           WHEN item.attempt_count>=p_max_attempts OR coalesce((p_error->>'retryable')::boolean,true)=false
             THEN now() ELSE NULL END,
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE item.tenant_id=p_tenant_id AND item.projection_id=p_projection_id
     AND item.status='running' AND item.lease_owner=p_worker_id
     AND item.lease_token=p_lease_token AND item.lease_expires_at>now()
  RETURNING item.* INTO projected;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'identity projection lease is stale' USING ERRCODE='55000';
  END IF;
  next_status:=projected.status;

  IF next_status='failed' THEN
    UPDATE control_plane.identity_review_tasks AS task
       SET resolution=task.resolution||jsonb_build_object(
             'projection_status','failed','projection_id',p_projection_id,
             'projection_error_code',coalesce(p_error->>'code','identity_projection_failed')
           ),updated_at=now()
     WHERE task.tenant_id=projected.tenant_id
       AND task.identity_review_task_id=projected.identity_review_task_id
       AND (task.resolution->>'decision_id')=projected.decision_id;
    INSERT INTO control_plane.audit_log (
      tenant_id,audit_id,actor_type,action,resource_type,resource_id,audit_metadata
    ) VALUES (
      projected.tenant_id,control_plane.generate_ulid(),'service',
      'identity.match_projection_failed','identity_review_task',projected.identity_review_task_id,
      jsonb_build_object(
        'decision_id',projected.decision_id,
        'decision_version',projected.decision_version,
        'projection_id',projected.projection_id,
        'error_code',coalesce(p_error->>'code','identity_projection_failed')
      )
    );
  END IF;
  RETURN next_status;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.identity_decision_projection_metrics()
RETURNS TABLE(status text,job_count bigint,oldest_age_seconds bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
  SELECT item.status,count(*)::bigint,
         extract(epoch FROM now()-min(item.created_at))::bigint
    FROM control_plane.identity_decision_projection_outbox AS item
   GROUP BY item.status ORDER BY item.status
$$;

-- Keep the transform login function-only for this sensitive command payload.
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
    'control_plane.worker_heartbeats',
    'control_plane.identity_decision_projection_outbox'
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

REVOKE ALL ON control_plane.identity_decision_projection_outbox
  FROM PUBLIC,anon,authenticated,service_role,albert_transform_control;
REVOKE ALL ON FUNCTION public.albert_decide_identity_match(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.claim_identity_decision_projection(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.complete_identity_decision_projection(text,text,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.fail_identity_decision_projection(text,text,text,text,jsonb,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.identity_decision_projection_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_decide_identity_match(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION control_plane.claim_identity_decision_projection(text,integer),
  control_plane.complete_identity_decision_projection(text,text,text,text,jsonb),
  control_plane.fail_identity_decision_projection(text,text,text,text,jsonb,integer,integer),
  control_plane.identity_decision_projection_metrics()
TO albert_transform_control;

COMMIT;
