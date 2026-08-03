BEGIN;

-- A browser can legitimately have two organisation tabs open while the
-- server-side active-tenant pointer changes. Every organisation mutation must
-- therefore bind the tenant the human actually loaded, not whichever tenant
-- happens to be selected when the request arrives. The per-user advisory lock
-- serializes selection with mutations; the tenant-row lock serializes the
-- complete membership roster and the deletion lifecycle.
CREATE OR REPLACE FUNCTION control_plane.require_expected_active_tenant(
  p_expected_tenant_id text,
  p_roles text[]
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  selected_tenant text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_expected_tenant_id IS NULL
     OR NOT control_plane.is_ulid(p_expected_tenant_id)
     OR p_roles IS NULL
     OR cardinality(p_roles) NOT BETWEEN 1 AND 3
     OR NOT p_roles <@ ARRAY['owner','manager','bookkeeper']::text[] THEN
    RAISE EXCEPTION 'expected organisation target is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('albert:tenant-bootstrap:' || actor::text, 0)
  );
  selected_tenant := control_plane.require_current_tenant_id();
  IF selected_tenant IS DISTINCT FROM p_expected_tenant_id THEN
    RAISE EXCEPTION 'organisation context changed; refresh before retrying'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
    FROM control_plane.tenants AS tenant
   WHERE tenant.tenant_id = p_expected_tenant_id
     AND tenant.status = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organisation is unavailable' USING ERRCODE = '55000';
  END IF;

  -- Authorization is deliberately checked after the tenant lock. A competing
  -- owner change may have committed while this transaction was waiting.
  IF NOT EXISTS (
    SELECT 1
      FROM control_plane.memberships AS membership
     WHERE membership.tenant_id = p_expected_tenant_id
       AND membership.user_id = actor
       AND membership.status = 'active'
       AND membership.role = ANY(p_roles)
  ) THEN
    RAISE EXCEPTION 'organisation role is unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN p_expected_tenant_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_select_organisation(p_tenant_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_tenant_id IS NULL OR NOT control_plane.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'organisation target is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('albert:tenant-bootstrap:' || actor::text, 0)
  );
  PERFORM 1
    FROM control_plane.tenants AS tenant
   WHERE tenant.tenant_id = p_tenant_id
     AND tenant.status = 'active'
   FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
      FROM control_plane.memberships AS membership
     WHERE membership.user_id = actor
       AND membership.tenant_id = p_tenant_id
       AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION 'organisation is unavailable' USING ERRCODE = '42501';
  END IF;
  INSERT INTO control_plane.user_active_tenants(user_id,tenant_id,selected_at)
  VALUES(actor,p_tenant_id,clock_timestamp())
  ON CONFLICT(user_id) DO UPDATE
    SET tenant_id = excluded.tenant_id,
        selected_at = excluded.selected_at;
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata
  ) VALUES (
    p_tenant_id,control_plane.generate_ulid(),actor,'user','tenant.selected',
    'tenant',p_tenant_id,'{}'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_rename_organisation(
  p_expected_tenant_id text,
  p_display_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text;
  actor uuid := extensions.albert_auth_uid();
  normalized_name text := btrim(p_display_name);
BEGIN
  IF normalized_name IS NULL OR length(normalized_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'display name must contain 1 to 120 characters'
      USING ERRCODE = '22023';
  END IF;
  selected_tenant := control_plane.require_expected_active_tenant(
    p_expected_tenant_id, ARRAY['owner']::text[]
  );
  UPDATE control_plane.tenants
     SET display_name = normalized_name
   WHERE tenant_id = selected_tenant;
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),actor,'user','tenant.renamed',
    'tenant',selected_tenant,jsonb_build_object('display_name',normalized_name)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_add_organisation_member(
  p_expected_tenant_id text,
  p_email text,
  p_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text;
  actor uuid := extensions.albert_auth_uid();
  normalized_email text := lower(btrim(p_email));
  invited_user uuid;
  existing control_plane.memberships%ROWTYPE;
  other_owner_count integer;
  rate_allowed boolean;
BEGIN
  IF p_role NOT IN ('owner','manager','bookkeeper') THEN
    RAISE EXCEPTION 'member role is invalid' USING ERRCODE = '22023';
  END IF;
  IF normalized_email IS NULL
     OR normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR length(normalized_email) > 320 THEN
    RAISE EXCEPTION 'member email is invalid' USING ERRCODE = '22023';
  END IF;
  selected_tenant := control_plane.require_expected_active_tenant(
    p_expected_tenant_id, ARRAY['owner']::text[]
  );
  SELECT allowed INTO rate_allowed
    FROM public.consume_albert_rate_limit('organisation.member_add',20,3600);
  IF NOT rate_allowed THEN
    RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE = 'P0001';
  END IF;
  SELECT resolved.id INTO invited_user
    FROM extensions.albert_auth_confirmed_user_by_email(normalized_email) AS resolved;
  IF invited_user IS NULL THEN
    RAISE EXCEPTION 'registered confirmed Albert user was not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO existing
    FROM control_plane.memberships
   WHERE tenant_id = selected_tenant
     AND user_id = invited_user
   FOR UPDATE;
  IF FOUND
     AND existing.role = 'owner'
     AND existing.status = 'active'
     AND p_role <> 'owner' THEN
    SELECT count(*) INTO other_owner_count
      FROM control_plane.memberships
     WHERE tenant_id = selected_tenant
       AND user_id <> invited_user
       AND role = 'owner'
       AND status = 'active';
    IF other_owner_count = 0 THEN
      RAISE EXCEPTION 'the organisation must retain an active owner'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO control_plane.memberships(
    tenant_id,membership_id,user_id,role,status,created_by
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),invited_user,p_role,'active',actor
  )
  ON CONFLICT (tenant_id,user_id) DO UPDATE
    SET role = excluded.role,
        status = 'active',
        created_by = actor;
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),actor,'user',
    'membership.activated','membership',invited_user::text,
    jsonb_build_object('role',p_role)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_update_organisation_member(
  p_expected_tenant_id text,
  p_user_id uuid,
  p_role text,
  p_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text;
  actor uuid := extensions.albert_auth_uid();
  existing control_plane.memberships%ROWTYPE;
  other_owner_count integer;
BEGIN
  IF p_user_id IS NULL
     OR p_role NOT IN ('owner','manager','bookkeeper')
     OR p_status NOT IN ('active','revoked') THEN
    RAISE EXCEPTION 'member update is invalid' USING ERRCODE = '22023';
  END IF;
  selected_tenant := control_plane.require_expected_active_tenant(
    p_expected_tenant_id, ARRAY['owner']::text[]
  );
  SELECT * INTO STRICT existing
    FROM control_plane.memberships
   WHERE tenant_id = selected_tenant
     AND user_id = p_user_id
   FOR UPDATE;
  IF p_user_id = actor AND p_status = 'revoked' THEN
    RAISE EXCEPTION 'you cannot revoke your own membership'
      USING ERRCODE = '22023';
  END IF;
  IF existing.role = 'owner' AND (p_role <> 'owner' OR p_status <> 'active') THEN
    SELECT count(*) INTO other_owner_count
      FROM control_plane.memberships
     WHERE tenant_id = selected_tenant
       AND user_id <> p_user_id
       AND role = 'owner'
       AND status = 'active';
    IF other_owner_count = 0 THEN
      RAISE EXCEPTION 'the organisation must retain an active owner'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  UPDATE control_plane.memberships
     SET role = p_role,
         status = p_status
   WHERE tenant_id = selected_tenant
     AND user_id = p_user_id;
  DELETE FROM control_plane.user_active_tenants
   WHERE user_id = p_user_id
     AND tenant_id = selected_tenant
     AND p_status = 'revoked';
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),actor,'user',
    'membership.updated','membership',p_user_id::text,
    jsonb_build_object('role',p_role,'status',p_status)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_request_tenant_deletion(
  p_expected_tenant_id text,
  p_confirmation text
)
RETURNS TABLE(
  deletion_request_id text,
  status text,
  approval_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text;
  actor uuid := extensions.albert_auth_uid();
  tenant_name text;
  generated_id text;
  rate_allowed boolean;
  approval_deadline timestamptz;
BEGIN
  selected_tenant := control_plane.require_expected_active_tenant(
    p_expected_tenant_id, ARRAY['owner']::text[]
  );
  SELECT allowed INTO rate_allowed
    FROM public.consume_albert_rate_limit('tenant.deletion_request',3,86400);
  IF NOT rate_allowed THEN
    RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE = 'P0001';
  END IF;
  SELECT tenant.display_name INTO STRICT tenant_name
    FROM control_plane.tenants AS tenant
   WHERE tenant.tenant_id = selected_tenant;
  IF p_confirmation IS DISTINCT FROM 'DELETE ' || tenant_name THEN
    RAISE EXCEPTION 'tenant deletion confirmation does not match'
      USING ERRCODE = '22023';
  END IF;
  generated_id := control_plane.generate_ulid();
  approval_deadline := clock_timestamp() + interval '30 minutes';
  INSERT INTO control_plane.deletion_requests(
    tenant_id,deletion_request_id,scope,status,requested_by,
    remote_revocation_status,credential_destroyed_at,purge_due_at,
    approval_expires_at,progress
  ) VALUES (
    selected_tenant,generated_id,'tenant','awaiting_approval',actor,
    'not_applicable',NULL,clock_timestamp(),approval_deadline,
    jsonb_build_object('request','confirmed')
  );
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),actor,'user',
    'tenant.deletion_requested','deletion_request',generated_id,
    jsonb_build_object('approval_expires_at',approval_deadline)
  );
  deletion_request_id := generated_id;
  status := 'awaiting_approval';
  approval_expires_at := approval_deadline;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_approve_tenant_deletion(
  p_expected_tenant_id text,
  p_deletion_request_id text,
  p_confirmation text
)
RETURNS TABLE(
  deletion_request_id text,
  status text,
  purge_due_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text;
  actor uuid := extensions.albert_auth_uid();
  tenant_name text;
  request_row control_plane.deletion_requests%ROWTYPE;
  rate_allowed boolean;
  purge_timestamp timestamptz;
BEGIN
  IF p_deletion_request_id IS NULL
     OR NOT control_plane.is_ulid(p_deletion_request_id) THEN
    RAISE EXCEPTION 'tenant deletion request is invalid' USING ERRCODE = '22023';
  END IF;
  selected_tenant := control_plane.require_expected_active_tenant(
    p_expected_tenant_id, ARRAY['owner']::text[]
  );
  SELECT allowed INTO rate_allowed
    FROM public.consume_albert_rate_limit('tenant.deletion_approval',5,86400);
  IF NOT rate_allowed THEN
    RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE = 'P0001';
  END IF;
  SELECT tenant.display_name INTO STRICT tenant_name
    FROM control_plane.tenants AS tenant
   WHERE tenant.tenant_id = selected_tenant;
  IF p_confirmation IS DISTINCT FROM 'ERASE ' || tenant_name THEN
    RAISE EXCEPTION 'tenant erasure confirmation does not match'
      USING ERRCODE = '22023';
  END IF;
  SELECT request.* INTO STRICT request_row
    FROM control_plane.deletion_requests AS request
   WHERE request.tenant_id = selected_tenant
     AND request.deletion_request_id = p_deletion_request_id
     AND request.scope = 'tenant'
   FOR UPDATE;
  IF request_row.status <> 'awaiting_approval'
     OR request_row.approval_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'tenant deletion approval is unavailable or expired'
      USING ERRCODE = '55000';
  END IF;
  purge_timestamp := clock_timestamp();
  UPDATE control_plane.deletion_requests AS request
     SET status = 'queued',
         approved_by = actor,
         approved_at = purge_timestamp,
         credential_destruction_due_at = purge_timestamp + interval '15 minutes',
         purge_due_at = purge_timestamp,
         progress = progress || jsonb_build_object('approval','confirmed')
   WHERE request.tenant_id = selected_tenant
     AND request.deletion_request_id = p_deletion_request_id;
  UPDATE control_plane.tenants
     SET status = 'deleting'
   WHERE tenant_id = selected_tenant;
  UPDATE control_plane.memberships
     SET status = 'suspended'
   WHERE tenant_id = selected_tenant;
  UPDATE control_plane.connections
     SET status = 'blocked',
         auth_health = 'revoked'
   WHERE tenant_id = selected_tenant;
  PERFORM control_plane.enqueue_deletion_request(p_deletion_request_id);
  deletion_request_id := p_deletion_request_id;
  status := 'queued';
  purge_due_at := purge_timestamp;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_cancel_tenant_deletion(
  p_expected_tenant_id text,
  p_deletion_request_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text;
  actor uuid := extensions.albert_auth_uid();
  rate_allowed boolean;
BEGIN
  IF p_deletion_request_id IS NULL
     OR NOT control_plane.is_ulid(p_deletion_request_id) THEN
    RAISE EXCEPTION 'tenant deletion request is invalid' USING ERRCODE = '22023';
  END IF;
  selected_tenant := control_plane.require_expected_active_tenant(
    p_expected_tenant_id, ARRAY['owner']::text[]
  );
  SELECT allowed INTO rate_allowed
    FROM public.consume_albert_rate_limit('tenant.deletion_cancel',5,86400);
  IF NOT rate_allowed THEN
    RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE = 'P0001';
  END IF;
  UPDATE control_plane.deletion_requests
     SET status = 'cancelled',
         completed_at = clock_timestamp()
   WHERE tenant_id = selected_tenant
     AND deletion_request_id = p_deletion_request_id
     AND scope = 'tenant'
     AND status = 'awaiting_approval';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant deletion request cannot be cancelled'
      USING ERRCODE = '55000';
  END IF;
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),actor,'user',
    'tenant.deletion_cancelled','deletion_request',p_deletion_request_id,
    '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION control_plane.require_expected_active_tenant(text,text[])
  FROM PUBLIC,anon,authenticated,service_role,
       albert_sync_control,albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control;

REVOKE ALL ON FUNCTION public.albert_select_organisation(text)
  FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_rename_organisation(text,text),
  public.albert_add_organisation_member(text,text,text),
  public.albert_update_organisation_member(text,uuid,text,text),
  public.albert_request_tenant_deletion(text,text),
  public.albert_approve_tenant_deletion(text,text,text),
  public.albert_cancel_tenant_deletion(text,text)
  FROM PUBLIC,anon,service_role;

-- Remove every context-only overload so PostgREST and direct callers cannot
-- bypass the explicit target fence.
REVOKE ALL ON FUNCTION public.albert_rename_organisation(text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.albert_add_organisation_member(text,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.albert_update_organisation_member(uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.albert_request_tenant_deletion(text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.albert_approve_tenant_deletion(text,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.albert_cancel_tenant_deletion(text)
  FROM PUBLIC,anon,authenticated,service_role;
DROP FUNCTION public.albert_rename_organisation(text);
DROP FUNCTION public.albert_add_organisation_member(text,text);
DROP FUNCTION public.albert_update_organisation_member(uuid,text,text);
DROP FUNCTION public.albert_request_tenant_deletion(text);
DROP FUNCTION public.albert_approve_tenant_deletion(text,text);
DROP FUNCTION public.albert_cancel_tenant_deletion(text);

GRANT EXECUTE ON FUNCTION public.albert_select_organisation(text),
  public.albert_rename_organisation(text,text),
  public.albert_add_organisation_member(text,text,text),
  public.albert_update_organisation_member(text,uuid,text,text),
  public.albert_request_tenant_deletion(text,text),
  public.albert_approve_tenant_deletion(text,text,text),
  public.albert_cancel_tenant_deletion(text,text)
  TO authenticated;

COMMIT;
