BEGIN;

ALTER TABLE control_plane.dossiers
  ADD COLUMN IF NOT EXISTS source_bundle_hash text;

ALTER TABLE control_plane.dossiers
  DROP CONSTRAINT IF EXISTS dossiers_source_bundle_hash_valid;
ALTER TABLE control_plane.dossiers
  ADD CONSTRAINT dossiers_source_bundle_hash_valid
  CHECK (source_bundle_hash IS NULL OR source_bundle_hash ~ '^[a-f0-9]{64}$');

DROP INDEX IF EXISTS control_plane.dossiers_tenant_source_bundle_idx;
CREATE INDEX dossiers_tenant_source_bundle_idx
  ON control_plane.dossiers (tenant_id, source_bundle_hash)
  WHERE source_bundle_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION control_plane.publish_transform_dossier(
  p_tenant_id text,
  p_content jsonb,
  p_provenance jsonb,
  p_source_bundle_hash text
)
RETURNS TABLE(dossier_id text, version integer, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_id text;
  selected_version integer;
  key_name text;
  fact_provenance jsonb;
  confidence_text text;
BEGIN
  IF NOT pg_has_role(session_user, 'albert_transform_control', 'MEMBER') THEN
    RAISE EXCEPTION 'transform dossier publication requires the transform runtime role'
      USING ERRCODE = '42501';
  END IF;
  IF nullif(current_setting('albert.tenant_id', true), '') IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'transform dossier tenant scope is not established'
      USING ERRCODE = '42501';
  END IF;
  IF p_tenant_id IS NULL
     OR p_content IS NULL
     OR p_provenance IS NULL
     OR p_source_bundle_hash IS NULL
     OR NOT control_plane.is_ulid(p_tenant_id)
     OR p_source_bundle_hash !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(p_content) <> 'object'
     OR jsonb_typeof(p_provenance) <> 'object'
     OR p_content = '{}'::jsonb THEN
    RAISE EXCEPTION 'transform dossier input is invalid' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_object_keys(p_content) AS supplied(key)
     WHERE supplied.key <> ALL (ARRAY[
       'industry','locations','trading_hours','seasonality',
       'gst_registration','accounting_basis','channels','base_currency'
     ])
  ) THEN
    RAISE EXCEPTION 'transform dossier contains an unsupported fact' USING ERRCODE = '22023';
  END IF;

  FOR key_name IN SELECT jsonb_object_keys(p_content)
  LOOP
    IF jsonb_typeof(p_content -> key_name) NOT IN ('string', 'array') THEN
      RAISE EXCEPTION 'transform dossier fact % has an invalid value', key_name USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_content -> key_name) = 'array' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_content -> key_name) AS item
       WHERE jsonb_typeof(item) <> 'string'
    ) THEN
      RAISE EXCEPTION 'transform dossier fact % has a non-text array item', key_name USING ERRCODE = '22023';
    END IF;
    fact_provenance := p_provenance -> key_name;
    confidence_text := fact_provenance ->> 'confidence';
    IF jsonb_typeof(fact_provenance) <> 'object'
       OR coalesce(length(btrim(fact_provenance ->> 'source')), 0) = 0
       OR coalesce(length(btrim(fact_provenance ->> 'observed_at')), 0) = 0
       OR confidence_text IS NULL
       OR confidence_text !~ '^(0(?:\.[0-9]+)?|1(?:\.0+)?)$'
       OR (confidence_text::numeric < 0 OR confidence_text::numeric > 1)
       OR (fact_provenance ->> 'confirmation_state') NOT IN ('source_reported', 'inferred') THEN
      RAISE EXCEPTION 'transform dossier provenance for % is invalid', key_name USING ERRCODE = '22023';
    END IF;
    PERFORM (fact_provenance ->> 'observed_at')::timestamptz;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('dossier:' || p_tenant_id, 0));
  SELECT candidate.dossier_id, candidate.version
    INTO selected_id, selected_version
    FROM control_plane.dossiers AS candidate
   WHERE candidate.tenant_id = p_tenant_id
     AND candidate.source_bundle_hash = p_source_bundle_hash
     AND candidate.status = 'published'
   ORDER BY candidate.version DESC
   LIMIT 1;
  IF selected_id IS NOT NULL THEN
    dossier_id := selected_id;
    version := selected_version;
    created := false;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT coalesce(max(candidate.version), 0) + 1
    INTO selected_version
    FROM control_plane.dossiers AS candidate
   WHERE candidate.tenant_id = p_tenant_id;
  selected_id := control_plane.generate_ulid();

  UPDATE control_plane.dossiers
     SET status = 'superseded', superseded_at = now()
   WHERE tenant_id = p_tenant_id AND status = 'published';
  INSERT INTO control_plane.dossiers (
    tenant_id, dossier_id, version, status, content, provenance,
    source_bundle_hash, published_at
  ) VALUES (
    p_tenant_id, selected_id, selected_version, 'published', p_content,
    p_provenance, p_source_bundle_hash, now()
  );
  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_type, action, resource_type, resource_id,
    audit_metadata
  ) VALUES (
    p_tenant_id, control_plane.generate_ulid(), 'service',
    'dossier.published', 'dossier', selected_id,
    jsonb_build_object(
      'version', selected_version,
      'source_bundle_hash', p_source_bundle_hash,
      'fact_count', (SELECT count(*) FROM jsonb_object_keys(p_content))
    )
  );

  dossier_id := selected_id;
  version := selected_version;
  created := true;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.publish_transform_dossier(text,jsonb,jsonb,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION control_plane.publish_transform_dossier(text,jsonb,jsonb,text)
  TO albert_transform_control;

COMMIT;
