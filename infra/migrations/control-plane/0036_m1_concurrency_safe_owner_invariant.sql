BEGIN;

-- Every membership mutation locks the tenant row before rechecking the actor's
-- authority or counting owners. The tenant row is the roster-wide mutex: row
-- locks on two different owner memberships cannot prevent a write-skew race.

CREATE OR REPLACE FUNCTION public.albert_add_organisation_member(
  p_email text,
  p_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := auth.uid();
  normalized_email text := lower(btrim(p_email));
  invited_user uuid;
  existing control_plane.memberships%ROWTYPE;
  other_owner_count integer;
  rate_allowed boolean;
BEGIN
  IF p_role NOT IN ('owner', 'manager', 'bookkeeper') THEN
    RAISE EXCEPTION 'member role is invalid' USING ERRCODE = '22023';
  END IF;
  IF normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR length(normalized_email) > 320 THEN
    RAISE EXCEPTION 'member email is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT control_plane.has_tenant_role(selected_tenant, ARRAY['owner']::text[]) THEN
    RAISE EXCEPTION 'owner role required' USING ERRCODE = '42501';
  END IF;

  SELECT allowed INTO rate_allowed
    FROM public.consume_albert_rate_limit('organisation.member_add', 20, 3600);
  IF NOT rate_allowed THEN
    RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO invited_user
    FROM auth.users
   WHERE lower(email) = normalized_email
     AND email_confirmed_at IS NOT NULL
   LIMIT 1;
  IF invited_user IS NULL THEN
    RAISE EXCEPTION 'registered confirmed Albert user was not found' USING ERRCODE = 'P0002';
  END IF;

  -- Serialize the complete roster, then repeat authorization inside the lock.
  PERFORM 1
    FROM control_plane.tenants
   WHERE tenant_id = selected_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organisation was not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT control_plane.has_tenant_role(selected_tenant, ARRAY['owner']::text[]) THEN
    RAISE EXCEPTION 'owner role required' USING ERRCODE = '42501';
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
      RAISE EXCEPTION 'the organisation must retain an active owner' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO control_plane.memberships (
    tenant_id, membership_id, user_id, role, status, created_by
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), invited_user, p_role, 'active', actor
  )
  ON CONFLICT (tenant_id, user_id) DO UPDATE
    SET role = excluded.role,
        status = 'active',
        created_by = actor;

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'membership.activated', 'membership', invited_user::text,
    jsonb_build_object('role', p_role)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_update_organisation_member(
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
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := auth.uid();
  existing control_plane.memberships%ROWTYPE;
  other_owner_count integer;
BEGIN
  IF p_role NOT IN ('owner', 'manager', 'bookkeeper')
     OR p_status NOT IN ('active', 'revoked') THEN
    RAISE EXCEPTION 'member update is invalid' USING ERRCODE = '22023';
  END IF;

  -- The tenant row, rather than the target membership row, serializes every
  -- owner transition. Authorization is repeated only after acquiring it.
  PERFORM 1
    FROM control_plane.tenants
   WHERE tenant_id = selected_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organisation was not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT control_plane.has_tenant_role(selected_tenant, ARRAY['owner']::text[]) THEN
    RAISE EXCEPTION 'owner role required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO STRICT existing
    FROM control_plane.memberships
   WHERE tenant_id = selected_tenant
     AND user_id = p_user_id
   FOR UPDATE;

  IF p_user_id = actor AND p_status = 'revoked' THEN
    RAISE EXCEPTION 'you cannot revoke your own membership' USING ERRCODE = '22023';
  END IF;
  IF existing.role = 'owner' AND (p_role <> 'owner' OR p_status <> 'active') THEN
    SELECT count(*) INTO other_owner_count
      FROM control_plane.memberships
     WHERE tenant_id = selected_tenant
       AND user_id <> p_user_id
       AND role = 'owner'
       AND status = 'active';
    IF other_owner_count = 0 THEN
      RAISE EXCEPTION 'the organisation must retain an active owner' USING ERRCODE = '22023';
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

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'membership.updated', 'membership', p_user_id::text,
    jsonb_build_object('role', p_role, 'status', p_status)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.albert_add_organisation_member(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_update_organisation_member(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_add_organisation_member(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_update_organisation_member(uuid, text, text) TO authenticated;

COMMIT;
