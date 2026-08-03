BEGIN;

-- Bootstrap is idempotent for a user, including when two first-page requests
-- arrive before either can observe a membership. Transaction-scoped advisory
-- locking avoids a permanent lock row and releases automatically on rollback.
CREATE OR REPLACE FUNCTION public.bootstrap_albert_tenant(
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
  actor uuid := auth.uid();
  existing_tenant text;
  created_tenant text;
  created_membership text;
  created_overlay text;
  normalized_name text := btrim(p_display_name);
  normalized_timezone text := btrim(p_timezone);
  generated_slug text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  -- The namespace prefix keeps this lock independent from other per-user
  -- advisory-lock protocols. Hash collisions only serialize unrelated users;
  -- they cannot weaken the one-bootstrap invariant.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('albert:tenant-bootstrap:' || actor::text, 0)
  );

  -- Recheck only after acquiring the user lock. A concurrent winner commits
  -- its membership before this transaction continues, so all callers return
  -- that same tenant and only the winner emits bootstrap rows/audit evidence.
  SELECT membership.tenant_id
    INTO existing_tenant
  FROM control_plane.memberships AS membership
  WHERE membership.user_id = actor
    AND membership.status = 'active'
  ORDER BY membership.created_at, membership.tenant_id
  LIMIT 1;

  IF existing_tenant IS NOT NULL THEN
    RETURN QUERY
      SELECT tenant.tenant_id,
             tenant.display_name,
             tenant.slug,
             membership.role,
             coalesce(overlay.overlay ->> 'timezone', 'Australia/Melbourne')
      FROM control_plane.tenants AS tenant
      JOIN control_plane.memberships AS membership
        ON membership.tenant_id = tenant.tenant_id
       AND membership.user_id = actor
       AND membership.status = 'active'
      LEFT JOIN LATERAL (
        SELECT candidate.overlay
        FROM control_plane.tenant_overlays AS candidate
        WHERE candidate.tenant_id = tenant.tenant_id
          AND candidate.status = 'published'
        ORDER BY candidate.version DESC
        LIMIT 1
      ) AS overlay ON true
      WHERE tenant.tenant_id = existing_tenant;
    RETURN;
  END IF;

  IF normalized_name IS NULL OR length(normalized_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'display name must contain 1 to 120 characters' USING ERRCODE = '22023';
  END IF;
  IF normalized_timezone IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = normalized_timezone
  ) THEN
    RAISE EXCEPTION 'timezone is not recognised' USING ERRCODE = '22023';
  END IF;

  created_tenant := control_plane.generate_ulid();
  created_membership := control_plane.generate_ulid();
  created_overlay := control_plane.generate_ulid();
  generated_slug := left(
    trim(both '-' FROM regexp_replace(lower(normalized_name), '[^a-z0-9]+', '-', 'g')),
    42
  );
  IF generated_slug = '' THEN
    generated_slug := 'organisation';
  END IF;
  generated_slug := generated_slug || '-' || lower(right(created_tenant, 6));

  INSERT INTO control_plane.tenants (
    tenant_id, slug, display_name, status, created_by
  ) VALUES (
    created_tenant, generated_slug, normalized_name, 'active', actor
  );

  INSERT INTO control_plane.memberships (
    tenant_id, membership_id, user_id, role, status, created_by
  ) VALUES (
    created_tenant, created_membership, actor, 'owner', 'active', actor
  );

  INSERT INTO control_plane.placement_registry (
    tenant_id, logical_cell_key, status, placement_metadata
  ) VALUES (
    created_tenant, 'cell_01', 'assigned', '{"region":"ap-southeast-2"}'::jsonb
  );

  INSERT INTO control_plane.tenant_overlays (
    tenant_id, overlay_id, version, status, overlay, change_reason,
    created_by, published_at
  ) VALUES (
    created_tenant,
    created_overlay,
    1,
    'published',
    jsonb_build_object(
      'timezone', normalized_timezone,
      'trading_day_cutoff', '00:00',
      'blocking_answers', '{}'::jsonb
    ),
    'Tenant bootstrap',
    actor,
    now()
  );

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    created_tenant,
    control_plane.generate_ulid(),
    actor,
    'user',
    'tenant.bootstrap',
    'tenant',
    created_tenant,
    jsonb_build_object('timezone', normalized_timezone)
  );

  RETURN QUERY SELECT created_tenant, normalized_name, generated_slug, 'owner'::text,
    normalized_timezone;
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_albert_tenant(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_albert_tenant(text, text) TO authenticated;

COMMIT;
