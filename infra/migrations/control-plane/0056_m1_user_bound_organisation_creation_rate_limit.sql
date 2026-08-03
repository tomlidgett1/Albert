BEGIN;

-- Organisation creation cannot use the ordinary tenant-scoped limiter after
-- a completed tenant deletion because no active tenant remains. Tenant scope
-- also lets a user evade a creation limit by selecting a different tenant.
-- Keep a narrow pseudonymous user bucket outside every tenant anchor so the
-- limit survives selection and deletion without retaining the Auth UUID.
CREATE TABLE IF NOT EXISTS control_plane.user_rate_limit_buckets (
  actor_digest text NOT NULL CHECK (actor_digest ~ '^[a-f0-9]{64}$'),
  action text NOT NULL REFERENCES control_plane.rate_limit_policies(action),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_digest,action,window_started_at),
  CHECK (action = 'organisation.create')
);

COMMENT ON TABLE control_plane.user_rate_limit_buckets IS
  'Pseudonymous, non-tenant creation throttles. Actor keys are domain-separated SHA-256 digests and expired windows are purged by the fixed consumer.';

-- Supersede pre-0056 tenant-scoped creation buckets. They are neither read nor
-- useful after this migration and retaining them would create misleading
-- upgrade residue in long-lived cells.
DELETE FROM control_plane.rate_limit_buckets
 WHERE action = 'organisation.create';

CREATE INDEX IF NOT EXISTS user_rate_limit_buckets_expiry_idx
  ON control_plane.user_rate_limit_buckets(window_started_at);

ALTER TABLE control_plane.user_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.user_rate_limit_buckets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE control_plane.user_rate_limit_buckets
  FROM PUBLIC,anon,authenticated,service_role,
       albert_sync_control,albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control;

DROP POLICY IF EXISTS migration_owner_user_rate_limit_buckets
  ON control_plane.user_rate_limit_buckets;
CREATE POLICY migration_owner_user_rate_limit_buckets
  ON control_plane.user_rate_limit_buckets
  FOR ALL TO albert_control_migration_owner
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION control_plane.purge_user_rate_limit_buckets()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM control_plane.user_rate_limit_buckets
   WHERE window_started_at < clock_timestamp() - interval '3 days';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.consume_organisation_creation_rate_limit()
RETURNS TABLE(allowed boolean,retry_after_seconds integer,remaining integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  actor_digest_value text;
  policy control_plane.rate_limit_policies%ROWTYPE;
  window_start timestamptz;
  consumed integer;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO STRICT policy
    FROM control_plane.rate_limit_policies
   WHERE action = 'organisation.create'
     AND enabled
     AND request_limit = 5
     AND window_seconds = 86400;
  actor_digest_value := encode(extensions.digest(
    convert_to('albert:user-rate-limit:v1:' || actor::text,'UTF8'),
    'sha256'
  ),'hex');
  window_start := to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) / policy.window_seconds)
      * policy.window_seconds
  );
  DELETE FROM control_plane.user_rate_limit_buckets
   WHERE window_started_at < window_start - interval '2 days';
  INSERT INTO control_plane.user_rate_limit_buckets(
    actor_digest,action,window_started_at,request_count
  ) VALUES (
    actor_digest_value,'organisation.create',window_start,1
  )
  ON CONFLICT(actor_digest,action,window_started_at) DO UPDATE
    SET request_count = control_plane.user_rate_limit_buckets.request_count + 1,
        updated_at = clock_timestamp()
  RETURNING request_count INTO consumed;
  allowed := consumed <= policy.request_limit;
  remaining := greatest(policy.request_limit - consumed,0);
  retry_after_seconds := CASE WHEN allowed THEN 0 ELSE greatest(
    1,
    ceil(extract(epoch FROM (
      window_start + make_interval(secs => policy.window_seconds)
      - clock_timestamp()
    )))::integer
  ) END;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_create_organisation(
  p_display_name text,
  p_timezone text
)
RETURNS TABLE(
  tenant_id text,
  tenant_name text,
  tenant_slug text,
  role text,
  timezone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  normalized_name text := btrim(p_display_name);
  normalized_timezone text := btrim(p_timezone);
  created_tenant text := control_plane.generate_ulid();
  created_membership text := control_plane.generate_ulid();
  created_overlay text := control_plane.generate_ulid();
  generated_slug text;
  rate_allowed boolean;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('albert:tenant-bootstrap:' || actor::text,0)
  );
  IF EXISTS (
    SELECT 1 FROM control_plane.tenant_deletion_receipts AS receipt
     WHERE receipt.requested_by = actor
       AND receipt.status IN (
         'awaiting_approval','queued','running','retry_wait','verifying','failed'
       )
  ) THEN
    RAISE EXCEPTION 'tenant deletion is still in progress'
      USING ERRCODE = '55000';
  END IF;
  IF normalized_name IS NULL OR length(normalized_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'display name must contain 1 to 120 characters'
      USING ERRCODE = '22023';
  END IF;
  IF normalized_timezone IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = normalized_timezone
  ) THEN
    RAISE EXCEPTION 'timezone is not recognised' USING ERRCODE = '22023';
  END IF;
  SELECT limited.allowed INTO rate_allowed
    FROM control_plane.consume_organisation_creation_rate_limit() AS limited;
  IF NOT rate_allowed THEN
    RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE = 'P0001';
  END IF;

  generated_slug := left(
    trim(both '-' FROM regexp_replace(
      lower(normalized_name),'[^a-z0-9]+','-','g'
    )),42
  );
  IF generated_slug = '' THEN generated_slug := 'organisation'; END IF;
  generated_slug := generated_slug || '-' || lower(right(created_tenant,6));
  INSERT INTO control_plane.tenants(tenant_id,slug,display_name,status,created_by)
  VALUES(created_tenant,generated_slug,normalized_name,'active',actor);
  INSERT INTO control_plane.memberships(
    tenant_id,membership_id,user_id,role,status,created_by
  ) VALUES(
    created_tenant,created_membership,actor,'owner','active',actor
  );
  INSERT INTO control_plane.placement_registry(
    tenant_id,logical_cell_key,status,placement_metadata
  ) VALUES(
    created_tenant,'cell_01','assigned','{"region":"ap-southeast-2"}'::jsonb
  );
  INSERT INTO control_plane.tenant_overlays(
    tenant_id,overlay_id,version,status,overlay,change_reason,
    created_by,published_at
  ) VALUES(
    created_tenant,created_overlay,1,'published',jsonb_build_object(
      'timezone',normalized_timezone,
      'trading_day_cutoff','00:00',
      'blocking_answers','{}'::jsonb
    ),'Organisation created',actor,clock_timestamp()
  );
  INSERT INTO control_plane.user_active_tenants(user_id,tenant_id,selected_at)
  VALUES(actor,created_tenant,clock_timestamp())
  ON CONFLICT(user_id) DO UPDATE
    SET tenant_id = excluded.tenant_id,
        selected_at = excluded.selected_at;
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata
  ) VALUES(
    created_tenant,control_plane.generate_ulid(),actor,'user','tenant.created',
    'tenant',created_tenant,jsonb_build_object('timezone',normalized_timezone)
  );
  RETURN QUERY SELECT created_tenant,normalized_name,generated_slug,
    'owner'::text,normalized_timezone;
END;
$$;

REVOKE ALL ON FUNCTION
  control_plane.consume_organisation_creation_rate_limit()
  FROM PUBLIC,anon,authenticated,service_role,
       albert_sync_control,albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.purge_user_rate_limit_buckets()
  FROM PUBLIC,anon,authenticated,service_role,
       albert_sync_control,albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control;
GRANT EXECUTE ON FUNCTION control_plane.purge_user_rate_limit_buckets()
  TO postgres;
REVOKE ALL ON FUNCTION public.albert_create_organisation(text,text)
  FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.albert_create_organisation(text,text)
  TO authenticated;

SELECT extensions.albert_install_user_rate_limit_retention_cron_job();

COMMIT;
