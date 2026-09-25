-- 0151: singleton Albert Nivo chart design.
--
-- Operators publish bar and line defaults from Admin. Authenticated chat
-- reads the same row so localhost and production render the same charts.

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.nivo_chart_design (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  design jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (jsonb_typeof(design) = 'object')
);

ALTER TABLE control_plane.nivo_chart_design ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.albert_chart_design()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  published jsonb;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication is required' USING ERRCODE = '42501';
  END IF;

  SELECT design.design
    INTO published
    FROM control_plane.nivo_chart_design AS design
   WHERE design.singleton;

  RETURN coalesce(published, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_save_chart_design(p_design jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
BEGIN
  IF actor IS NULL OR NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE = '42501';
  END IF;
  IF p_design IS NULL OR jsonb_typeof(p_design) <> 'object' THEN
    RAISE EXCEPTION 'chart design must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_design::text) > 65536 THEN
    RAISE EXCEPTION 'chart design is too large' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.nivo_chart_design (singleton, design, updated_at, updated_by)
  VALUES (true, p_design, now(), actor)
  ON CONFLICT (singleton) DO UPDATE
    SET design = excluded.design,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by;

  INSERT INTO control_plane.operator_audit_log (
    operator_audit_id, actor_user_id, action, request_metadata
  ) VALUES (
    control_plane.generate_ulid(),
    actor,
    'operator.chart_design_save',
    jsonb_build_object('bytes', octet_length(p_design::text))
  );

  RETURN jsonb_build_object('saved', true, 'updatedAt', now());
END;
$$;

REVOKE ALL ON TABLE control_plane.nivo_chart_design FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.albert_chart_design() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_save_chart_design(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_chart_design() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_save_chart_design(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
