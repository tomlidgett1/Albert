-- 0180: iMessage enrolment — who may text the tenant's Albert line, and
-- whether group chats are answered. Companion to the imessage-bridge service
-- (services/imessage-bridge), which reads this through the owner session on
-- every inbound Linq delivery; the /imessage page manages it.
--
-- Access posture: reads for every active member; writes owner/manager only —
-- enrolling a phone number grants that number the tenant's full analytical
-- surface, so it is an administration action. SECURITY DEFINER RPCs in the
-- 0161 shape; RLS on, no direct table policies.

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.tenant_imessage_enrollments (
  tenant_id text NOT NULL,
  enrollment_id text NOT NULL DEFAULT control_plane.generate_ulid(),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{5,14}$'),
  display_name text CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 80),
  email text CHECK (email IS NULL OR (position('@' IN email) > 1 AND length(email) <= 254)),
  -- The tenant owner's own line: never removable, never disabled, so the
  -- owner cannot lock themselves out of their own agent from the UI.
  is_owner boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (tenant_id, enrollment_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_imessage_enrollments_phone
  ON control_plane.tenant_imessage_enrollments (tenant_id, phone_e164);
ALTER TABLE control_plane.tenant_imessage_enrollments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS control_plane.tenant_imessage_settings (
  tenant_id text PRIMARY KEY,
  allow_group_chats boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE control_plane.tenant_imessage_settings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.imessage_enrollment_json(enrollment control_plane.tenant_imessage_enrollments)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'enrollmentId', enrollment.enrollment_id,
    'phone', enrollment.phone_e164,
    'displayName', enrollment.display_name,
    'email', enrollment.email,
    'isOwner', enrollment.is_owner,
    'enabled', enrollment.enabled,
    'createdAt', enrollment.created_at
  );
$$;

-- Read: any active member — the bridge's owner session and the /imessage page.
CREATE OR REPLACE FUNCTION public.albert_imessage_workspace()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'allowGroupChats', coalesce((
      SELECT settings.allow_group_chats
      FROM control_plane.tenant_imessage_settings AS settings
      WHERE settings.tenant_id = control_plane.require_current_tenant_id()
    ), false),
    'enrollments', coalesce((
      SELECT jsonb_agg(control_plane.imessage_enrollment_json(enrollment)
        ORDER BY enrollment.is_owner DESC, enrollment.created_at ASC)
      FROM control_plane.tenant_imessage_enrollments AS enrollment
      WHERE enrollment.tenant_id = control_plane.require_current_tenant_id()
    ), '[]'::jsonb)
  );
$$;

-- Enrol (or revive) one number. Owner/manager. Re-adding an existing number
-- updates its name and re-enables it rather than duplicating.
CREATE OR REPLACE FUNCTION public.albert_imessage_enroll(
  p_phone text,
  p_display_name text DEFAULT NULL,
  p_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
  v_actor uuid := extensions.albert_auth_uid();
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g');
  v_count integer;
  v_existing boolean;
  v_row control_plane.tenant_imessage_enrollments%ROWTYPE;
BEGIN
  IF v_phone !~ '^\+[1-9][0-9]{5,14}$' THEN
    RAISE EXCEPTION 'phone number must be E.164, like +61414187820' USING ERRCODE = '22023';
  END IF;
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for enrolling iMessage numbers' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_count
    FROM control_plane.tenant_imessage_enrollments
    WHERE tenant_id = v_tenant_id;
  SELECT EXISTS (
    SELECT 1 FROM control_plane.tenant_imessage_enrollments
    WHERE tenant_id = v_tenant_id AND phone_e164 = v_phone
  ) INTO v_existing;
  IF v_count >= 20 AND NOT v_existing THEN
    RAISE EXCEPTION 'this organisation already has 20 enrolled numbers; remove one first' USING ERRCODE = '54000';
  END IF;

  INSERT INTO control_plane.tenant_imessage_enrollments (
    tenant_id, phone_e164, display_name, email, created_by, updated_by
  ) VALUES (
    v_tenant_id, v_phone,
    nullif(btrim(coalesce(p_display_name, '')), ''),
    nullif(btrim(coalesce(p_email, '')), ''),
    v_actor, v_actor
  )
  ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET
    display_name = coalesce(EXCLUDED.display_name, control_plane.tenant_imessage_enrollments.display_name),
    email = coalesce(EXCLUDED.email, control_plane.tenant_imessage_enrollments.email),
    enabled = true,
    updated_at = clock_timestamp(),
    updated_by = v_actor
  RETURNING * INTO v_row;

  RETURN control_plane.imessage_enrollment_json(v_row)
    || jsonb_build_object('existed', v_existing);
END;
$$;

-- Enable/disable one enrolment. Owner/manager; the owner row stays enabled.
CREATE OR REPLACE FUNCTION public.albert_imessage_update_enrollment(
  p_enrollment_id text,
  p_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
  v_actor uuid := extensions.albert_auth_uid();
  v_row control_plane.tenant_imessage_enrollments%ROWTYPE;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for updating iMessage enrolments' USING ERRCODE = '42501';
  END IF;
  UPDATE control_plane.tenant_imessage_enrollments SET
    enabled = p_enabled,
    updated_at = clock_timestamp(),
    updated_by = v_actor
  WHERE tenant_id = v_tenant_id
    AND enrollment_id = p_enrollment_id
    AND NOT (is_owner AND p_enabled = false)
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM control_plane.tenant_imessage_enrollments
      WHERE tenant_id = v_tenant_id AND enrollment_id = p_enrollment_id AND is_owner
    ) THEN
      RAISE EXCEPTION 'the owner''s number cannot be disabled' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'no such enrolment' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.imessage_enrollment_json(v_row);
END;
$$;

-- Remove one enrolment. Owner/manager; the owner row is not removable.
CREATE OR REPLACE FUNCTION public.albert_imessage_remove_enrollment(p_enrollment_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for removing iMessage enrolments' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.tenant_imessage_enrollments
    WHERE tenant_id = v_tenant_id AND enrollment_id = p_enrollment_id AND is_owner
  ) THEN
    RAISE EXCEPTION 'the owner''s number cannot be removed' USING ERRCODE = '42501';
  END IF;
  DELETE FROM control_plane.tenant_imessage_enrollments
  WHERE tenant_id = v_tenant_id AND enrollment_id = p_enrollment_id;
  RETURN FOUND;
END;
$$;

-- Group chats on or off for the tenant. Owner/manager.
CREATE OR REPLACE FUNCTION public.albert_imessage_set_group_chats(p_allowed boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
  v_actor uuid := extensions.albert_auth_uid();
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for iMessage settings' USING ERRCODE = '42501';
  END IF;
  INSERT INTO control_plane.tenant_imessage_settings (tenant_id, allow_group_chats, updated_by)
  VALUES (v_tenant_id, p_allowed, v_actor)
  ON CONFLICT (tenant_id) DO UPDATE SET
    allow_group_chats = EXCLUDED.allow_group_chats,
    updated_at = clock_timestamp(),
    updated_by = v_actor;
  RETURN jsonb_build_object('allowGroupChats', p_allowed);
END;
$$;

REVOKE ALL ON FUNCTION control_plane.imessage_enrollment_json(control_plane.tenant_imessage_enrollments) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_imessage_workspace() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_imessage_enroll(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_imessage_update_enrollment(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_imessage_remove_enrollment(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_imessage_set_group_chats(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_imessage_workspace() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_imessage_enroll(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_imessage_update_enrollment(text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_imessage_remove_enrollment(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_imessage_set_group_chats(boolean) TO authenticated;

COMMIT;
