BEGIN;

-- Existing databases may still have the original organisation functions that
-- read the managed Auth directory directly. Replace those two consumers before
-- the fixed administrator helper removes that temporary column-level grant.
CREATE OR REPLACE FUNCTION public.albert_organisation_settings()
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
    'tenant', jsonb_build_object(
      'tenantId', tenant.tenant_id,
      'name', tenant.display_name,
      'slug', tenant.slug,
      'status', tenant.status,
      'role', membership.role,
      'timezone', coalesce(overlay.overlay->>'timezone', 'Australia/Melbourne')
    ),
    'members', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'userId', member.user_id,
        'email', auth_user.email,
        'role', member.role,
        'status', member.status,
        'createdAt', member.created_at,
        'isCurrentUser', member.user_id = extensions.albert_auth_uid()
      ) ORDER BY
        CASE member.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
        auth_user.email)
      FROM control_plane.memberships AS member
      JOIN LATERAL extensions.albert_auth_users_by_ids(ARRAY[member.user_id]) AS auth_user
        ON auth_user.id = member.user_id
      WHERE member.tenant_id = selected_tenant
        AND member.status IN ('active', 'suspended')
    ), '[]'::jsonb),
    'deletion', (
      SELECT jsonb_build_object(
        'deletionRequestId', request.deletion_request_id,
        'status', request.status,
        'requestedAt', request.requested_at,
        'approvalExpiresAt', request.approval_expires_at,
        'completedAt', request.completed_at,
        'proofId', request.proof_id
      )
      FROM control_plane.deletion_requests AS request
      WHERE request.tenant_id = selected_tenant
        AND request.scope = 'tenant'
        AND request.status <> 'cancelled'
      ORDER BY request.requested_at DESC
      LIMIT 1
    )
  ) INTO result
  FROM control_plane.tenants AS tenant
  JOIN control_plane.memberships AS membership
    ON membership.tenant_id = tenant.tenant_id
   AND membership.user_id = extensions.albert_auth_uid()
   AND membership.status = 'active'
  LEFT JOIN LATERAL (
    SELECT candidate.overlay
    FROM control_plane.tenant_overlays AS candidate
    WHERE candidate.tenant_id = tenant.tenant_id
      AND candidate.status = 'published'
    ORDER BY candidate.version DESC
    LIMIT 1
  ) AS overlay ON true
  WHERE tenant.tenant_id = selected_tenant;
  IF result IS NULL THEN
    RAISE EXCEPTION 'organisation was not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN result;
END;
$$;

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
  actor uuid := extensions.albert_auth_uid();
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

  SELECT resolved.id INTO invited_user
    FROM extensions.albert_auth_confirmed_user_by_email(normalized_email) AS resolved;
  IF invited_user IS NULL THEN
    RAISE EXCEPTION 'registered confirmed Albert user was not found' USING ERRCODE = 'P0002';
  END IF;

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

REVOKE ALL ON FUNCTION public.albert_organisation_settings()
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.albert_add_organisation_member(text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.albert_organisation_settings()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_add_organisation_member(text, text)
  TO authenticated;

SELECT extensions.albert_install_raw_payload_bucket();
SELECT extensions.albert_install_auth_user_foreign_keys();

DO $$
DECLARE
  auth_reference_count integer;
  auth_user_relation oid;
BEGIN
  SELECT class.oid
    INTO STRICT auth_user_relation
    FROM pg_class AS class
    JOIN pg_namespace AS namespace ON namespace.oid=class.relnamespace
   WHERE namespace.nspname='auth'
     AND class.relname='users';
  SELECT count(*)
    INTO auth_reference_count
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS source_table ON source_table.oid=constraint_row.conrelid
    JOIN pg_namespace AS source_schema ON source_schema.oid=source_table.relnamespace
   WHERE constraint_row.contype = 'f'
     AND constraint_row.confrelid = auth_user_relation
     AND source_schema.nspname='control_plane';
  IF auth_reference_count <> 28 THEN
    RAISE EXCEPTION 'expected 28 fixed Auth user references, found %', auth_reference_count;
  END IF;
  IF has_any_column_privilege(
    'albert_control_migration_owner'::regrole::oid,
    auth_user_relation,
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'migration owner retains a direct Auth user read path';
  END IF;
  IF has_function_privilege(
    'albert_control_migration_owner',
    'extensions.albert_install_auth_user_foreign_keys()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'the one-use Auth foreign-key installer remains executable';
  END IF;
  IF has_function_privilege(
    'albert_control_migration_owner',
    'extensions.albert_install_raw_payload_bucket()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'the one-use raw payload bucket installer remains executable';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_auth_members AS membership
     WHERE membership.member = 'albert_control_migration_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'migration owner must not inherit another database role';
  END IF;
  IF (SELECT rolinherit FROM pg_roles WHERE rolname='albert_control_migration_owner') THEN
    RAISE EXCEPTION 'migration owner must remain NOINHERIT';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'extensions.albert_auth_users_by_ids(uuid[])',
    'EXECUTE'
  ) OR has_function_privilege(
    'service_role',
    'extensions.albert_auth_confirmed_user_by_email(text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'an Auth directory helper leaked to a generic runtime role';
  END IF;
  IF EXISTS (
    SELECT 1
     FROM pg_proc AS routine
     WHERE routine.proowner = 'albert_control_migration_owner'::regrole
       AND position('auth' || '.' || 'users' in pg_get_functiondef(routine.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'a migration-owned function still reads the managed Auth directory';
  END IF;
END;
$$;

COMMIT;
