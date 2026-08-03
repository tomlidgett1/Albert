BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.user_active_tenants (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,user_id)
    REFERENCES control_plane.memberships(tenant_id,user_id) ON DELETE CASCADE
);

ALTER TABLE control_plane.user_active_tenants ENABLE ROW LEVEL SECURITY;

-- Selection is mediated by a SECURITY DEFINER function so callers can never
-- point another user at a tenant or select a tenant without active membership.
REVOKE ALL ON control_plane.user_active_tenants FROM PUBLIC,anon,authenticated,service_role;

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('organisation.create', 5, 86400, true),
  ('organisation.member_add', 20, 3600, true)
ON CONFLICT (action) DO UPDATE SET
  request_limit=EXCLUDED.request_limit,
  window_seconds=EXCLUDED.window_seconds,
  audit_excess=EXCLUDED.audit_excess,
  enabled=true;

CREATE OR REPLACE FUNCTION control_plane.current_selected_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT coalesce(
    (
      SELECT selected.tenant_id
      FROM control_plane.user_active_tenants AS selected
      JOIN control_plane.memberships AS membership
        ON membership.tenant_id=selected.tenant_id
       AND membership.user_id=selected.user_id
       AND membership.status='active'
      JOIN control_plane.tenants AS tenant
        ON tenant.tenant_id=membership.tenant_id
       AND tenant.status='active'
      WHERE selected.user_id=auth.uid()
    ),
    (
      SELECT membership.tenant_id
      FROM control_plane.memberships AS membership
      JOIN control_plane.tenants AS tenant
        ON tenant.tenant_id=membership.tenant_id
       AND tenant.status='active'
      WHERE membership.user_id=auth.uid()
        AND membership.status='active'
        AND membership.tenant_id=nullif(auth.jwt()->'app_metadata'->>'active_tenant_id','')
      LIMIT 1
    ),
    (
      SELECT membership.tenant_id
      FROM control_plane.memberships AS membership
      JOIN control_plane.tenants AS tenant
        ON tenant.tenant_id=membership.tenant_id
       AND tenant.status='active'
      WHERE membership.user_id=auth.uid()
        AND membership.status='active'
      ORDER BY membership.created_at,membership.tenant_id
      LIMIT 1
    )
  );
$$;

CREATE OR REPLACE FUNCTION control_plane.require_current_tenant_id()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid:=auth.uid();
  resolved_tenant text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='42501';
  END IF;
  resolved_tenant:=control_plane.current_selected_tenant_id();
  IF resolved_tenant IS NULL THEN
    RAISE EXCEPTION 'no Albert organisation exists for this user' USING ERRCODE='P0002';
  END IF;
  RETURN resolved_tenant;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_albert_context()
RETURNS TABLE (
  tenant_id text,
  tenant_name text,
  tenant_slug text,
  role text,
  timezone text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT tenant.tenant_id,
         tenant.display_name,
         tenant.slug,
         membership.role,
         coalesce(overlay.overlay->>'timezone','Australia/Melbourne')
  FROM control_plane.memberships AS membership
  JOIN control_plane.tenants AS tenant
    ON tenant.tenant_id=membership.tenant_id
  LEFT JOIN LATERAL (
    SELECT candidate.overlay
    FROM control_plane.tenant_overlays AS candidate
    WHERE candidate.tenant_id=tenant.tenant_id
      AND candidate.status='published'
    ORDER BY candidate.version DESC
    LIMIT 1
  ) AS overlay ON true
  WHERE auth.uid() IS NOT NULL
    AND membership.user_id=auth.uid()
    AND membership.status='active'
    AND tenant.status='active'
    AND tenant.tenant_id=control_plane.current_selected_tenant_id()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.albert_list_organisations()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'tenantId',tenant.tenant_id,
    'name',tenant.display_name,
    'slug',tenant.slug,
    'role',membership.role,
    'status',tenant.status,
    'timezone',coalesce(overlay.overlay->>'timezone','Australia/Melbourne'),
    'selected',tenant.tenant_id=control_plane.current_selected_tenant_id()
  ) ORDER BY membership.created_at,tenant.display_name),'[]'::jsonb)
  FROM control_plane.memberships AS membership
  JOIN control_plane.tenants AS tenant
    ON tenant.tenant_id=membership.tenant_id
  LEFT JOIN LATERAL (
    SELECT candidate.overlay
    FROM control_plane.tenant_overlays AS candidate
    WHERE candidate.tenant_id=tenant.tenant_id
      AND candidate.status='published'
    ORDER BY candidate.version DESC
    LIMIT 1
  ) AS overlay ON true
  WHERE auth.uid() IS NOT NULL
    AND membership.user_id=auth.uid()
    AND membership.status='active'
    AND tenant.status IN ('active','deleting');
$$;

CREATE OR REPLACE FUNCTION public.albert_select_organisation(p_tenant_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM control_plane.memberships AS membership
    JOIN control_plane.tenants AS tenant ON tenant.tenant_id=membership.tenant_id
    WHERE membership.user_id=actor
      AND membership.tenant_id=p_tenant_id
      AND membership.status='active'
      AND tenant.status='active'
  ) THEN
    RAISE EXCEPTION 'organisation is unavailable' USING ERRCODE='42501';
  END IF;
  INSERT INTO control_plane.user_active_tenants(user_id,tenant_id,selected_at)
  VALUES(actor,p_tenant_id,clock_timestamp())
  ON CONFLICT(user_id) DO UPDATE SET tenant_id=excluded.tenant_id,selected_at=excluded.selected_at;
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,resource_type,resource_id,audit_metadata
  ) VALUES (
    p_tenant_id,control_plane.generate_ulid(),actor,'user','tenant.selected','tenant',p_tenant_id,'{}'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_create_organisation(
  p_display_name text,
  p_timezone text
)
RETURNS TABLE (
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
  actor uuid:=auth.uid();
  normalized_name text:=btrim(p_display_name);
  normalized_timezone text:=btrim(p_timezone);
  created_tenant text:=control_plane.generate_ulid();
  created_membership text:=control_plane.generate_ulid();
  created_overlay text:=control_plane.generate_ulid();
  generated_slug text;
  rate_allowed boolean;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  SELECT allowed INTO rate_allowed FROM public.consume_albert_rate_limit('organisation.create',5,86400);
  IF NOT rate_allowed THEN RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE='P0001'; END IF;
  IF length(normalized_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'display name must contain 1 to 120 characters' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=normalized_timezone) THEN
    RAISE EXCEPTION 'timezone is not recognised' USING ERRCODE='22023';
  END IF;
  generated_slug:=left(trim(both '-' FROM regexp_replace(lower(normalized_name),'[^a-z0-9]+','-','g')),42);
  IF generated_slug='' THEN generated_slug:='organisation'; END IF;
  generated_slug:=generated_slug||'-'||lower(right(created_tenant,6));

  INSERT INTO control_plane.tenants(tenant_id,slug,display_name,status,created_by)
  VALUES(created_tenant,generated_slug,normalized_name,'active',actor);
  INSERT INTO control_plane.memberships(tenant_id,membership_id,user_id,role,status,created_by)
  VALUES(created_tenant,created_membership,actor,'owner','active',actor);
  INSERT INTO control_plane.placement_registry(tenant_id,logical_cell_key,status,placement_metadata)
  VALUES(created_tenant,'cell_01','assigned','{"region":"ap-southeast-2"}'::jsonb);
  INSERT INTO control_plane.tenant_overlays(
    tenant_id,overlay_id,version,status,overlay,change_reason,created_by,published_at
  ) VALUES (
    created_tenant,created_overlay,1,'published',jsonb_build_object(
      'timezone',normalized_timezone,
      'trading_day_cutoff','00:00',
      'blocking_answers','{}'::jsonb
    ),'Organisation created',actor,now()
  );
  INSERT INTO control_plane.user_active_tenants(user_id,tenant_id,selected_at)
  VALUES(actor,created_tenant,clock_timestamp())
  ON CONFLICT(user_id) DO UPDATE SET tenant_id=excluded.tenant_id,selected_at=excluded.selected_at;
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,resource_type,resource_id,audit_metadata
  ) VALUES (
    created_tenant,control_plane.generate_ulid(),actor,'user','tenant.created','tenant',created_tenant,
    jsonb_build_object('timezone',normalized_timezone)
  );
  RETURN QUERY SELECT created_tenant,normalized_name,generated_slug,'owner'::text,normalized_timezone;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_organisation_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE selected_tenant text:=control_plane.require_current_tenant_id(); result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'tenant',jsonb_build_object(
      'tenantId',tenant.tenant_id,
      'name',tenant.display_name,
      'slug',tenant.slug,
      'status',tenant.status,
      'role',membership.role,
      'timezone',coalesce(overlay.overlay->>'timezone','Australia/Melbourne')
    ),
    'members',coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'userId',member.user_id,
        'email',auth_user.email,
        'role',member.role,
        'status',member.status,
        'createdAt',member.created_at,
        'isCurrentUser',member.user_id=auth.uid()
      ) ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,auth_user.email)
      FROM control_plane.memberships AS member
      JOIN auth.users AS auth_user ON auth_user.id=member.user_id
      WHERE member.tenant_id=selected_tenant
        AND member.status IN ('active','suspended')
    ),'[]'::jsonb),
    'deletion',(
      SELECT jsonb_build_object(
        'deletionRequestId',request.deletion_request_id,
        'status',request.status,
        'requestedAt',request.requested_at,
        'approvalExpiresAt',request.approval_expires_at,
        'completedAt',request.completed_at,
        'proofId',request.proof_id
      )
      FROM control_plane.deletion_requests AS request
      WHERE request.tenant_id=selected_tenant
        AND request.scope='tenant'
        AND request.status NOT IN ('cancelled')
      ORDER BY request.requested_at DESC
      LIMIT 1
    )
  ) INTO result
  FROM control_plane.tenants AS tenant
  JOIN control_plane.memberships AS membership
    ON membership.tenant_id=tenant.tenant_id
   AND membership.user_id=auth.uid()
   AND membership.status='active'
  LEFT JOIN LATERAL (
    SELECT candidate.overlay
    FROM control_plane.tenant_overlays AS candidate
    WHERE candidate.tenant_id=tenant.tenant_id AND candidate.status='published'
    ORDER BY candidate.version DESC LIMIT 1
  ) AS overlay ON true
  WHERE tenant.tenant_id=selected_tenant;
  IF result IS NULL THEN RAISE EXCEPTION 'organisation was not found' USING ERRCODE='P0002'; END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_rename_organisation(p_display_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE selected_tenant text:=control_plane.require_current_tenant_id(); actor uuid:=auth.uid(); normalized_name text:=btrim(p_display_name);
BEGIN
  IF NOT control_plane.has_tenant_role(selected_tenant,ARRAY['owner']::text[]) THEN
    RAISE EXCEPTION 'owner role required' USING ERRCODE='42501';
  END IF;
  IF length(normalized_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'display name must contain 1 to 120 characters' USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.tenants SET display_name=normalized_name WHERE tenant_id=selected_tenant;
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,resource_type,resource_id,audit_metadata
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),actor,'user','tenant.renamed','tenant',selected_tenant,
    jsonb_build_object('display_name',normalized_name)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_add_organisation_member(p_email text,p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text:=control_plane.require_current_tenant_id();
  actor uuid:=auth.uid();
  normalized_email text:=lower(btrim(p_email));
  invited_user uuid;
  rate_allowed boolean;
BEGIN
  IF NOT control_plane.has_tenant_role(selected_tenant,ARRAY['owner']::text[]) THEN
    RAISE EXCEPTION 'owner role required' USING ERRCODE='42501';
  END IF;
  IF p_role NOT IN ('owner','manager','bookkeeper') THEN
    RAISE EXCEPTION 'member role is invalid' USING ERRCODE='22023';
  END IF;
  IF normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR length(normalized_email)>320 THEN
    RAISE EXCEPTION 'member email is invalid' USING ERRCODE='22023';
  END IF;
  SELECT allowed INTO rate_allowed FROM public.consume_albert_rate_limit('organisation.member_add',20,3600);
  IF NOT rate_allowed THEN RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE='P0001'; END IF;
  SELECT id INTO invited_user FROM auth.users
  WHERE lower(email)=normalized_email AND email_confirmed_at IS NOT NULL
  LIMIT 1;
  IF invited_user IS NULL THEN
    RAISE EXCEPTION 'registered confirmed Albert user was not found' USING ERRCODE='P0002';
  END IF;
  INSERT INTO control_plane.memberships(
    tenant_id,membership_id,user_id,role,status,created_by
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),invited_user,p_role,'active',actor
  )
  ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=excluded.role,status='active',created_by=actor;
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,resource_type,resource_id,audit_metadata
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),actor,'user','membership.activated','membership',invited_user::text,
    jsonb_build_object('role',p_role)
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
  selected_tenant text:=control_plane.require_current_tenant_id();
  actor uuid:=auth.uid();
  existing control_plane.memberships%ROWTYPE;
  other_owner_count integer;
BEGIN
  IF NOT control_plane.has_tenant_role(selected_tenant,ARRAY['owner']::text[]) THEN
    RAISE EXCEPTION 'owner role required' USING ERRCODE='42501';
  END IF;
  IF p_role NOT IN ('owner','manager','bookkeeper') OR p_status NOT IN ('active','revoked') THEN
    RAISE EXCEPTION 'member update is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT existing FROM control_plane.memberships
  WHERE tenant_id=selected_tenant AND user_id=p_user_id FOR UPDATE;
  IF p_user_id=actor AND p_status='revoked' THEN
    RAISE EXCEPTION 'you cannot revoke your own membership' USING ERRCODE='22023';
  END IF;
  IF existing.role='owner' AND (p_role<>'owner' OR p_status<>'active') THEN
    SELECT count(*) INTO other_owner_count FROM control_plane.memberships
    WHERE tenant_id=selected_tenant AND user_id<>p_user_id AND role='owner' AND status='active';
    IF other_owner_count=0 THEN
      RAISE EXCEPTION 'the organisation must retain an active owner' USING ERRCODE='22023';
    END IF;
  END IF;
  UPDATE control_plane.memberships
  SET role=p_role,status=p_status
  WHERE tenant_id=selected_tenant AND user_id=p_user_id;
  DELETE FROM control_plane.user_active_tenants
  WHERE user_id=p_user_id AND tenant_id=selected_tenant AND p_status='revoked';
  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,resource_type,resource_id,audit_metadata
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),actor,'user','membership.updated','membership',p_user_id::text,
    jsonb_build_object('role',p_role,'status',p_status)
  );
END;
$$;

-- Membership mutation must pass through the guarded RPCs above so an owner
-- cannot accidentally remove the final owner or manufacture an unverified user.
DROP POLICY IF EXISTS tenant_owners_insert ON control_plane.memberships;
DROP POLICY IF EXISTS tenant_owners_update ON control_plane.memberships;
DROP POLICY IF EXISTS tenant_owners_delete ON control_plane.memberships;
REVOKE INSERT,UPDATE,DELETE ON control_plane.memberships FROM authenticated;

REVOKE ALL ON FUNCTION control_plane.current_selected_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.require_current_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_albert_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_list_organisations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_select_organisation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_create_organisation(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_organisation_settings() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_rename_organisation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_add_organisation_member(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_update_organisation_member(uuid,text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION control_plane.current_selected_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION control_plane.require_current_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_albert_context() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_list_organisations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_select_organisation(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_create_organisation(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_organisation_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_rename_organisation(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_add_organisation_member(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_update_organisation_member(uuid,text,text) TO authenticated;

COMMIT;
