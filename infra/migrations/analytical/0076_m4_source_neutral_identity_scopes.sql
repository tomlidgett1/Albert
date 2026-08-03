BEGIN;

-- A worker's local shop/company identifier is not cross-source evidence. Keep
-- the source reference so the transform can derive a neutral digest from an
-- accepted location association, or from the same normalized name+address
-- evidence used by location review. Never hash provider-local IDs together.
ALTER TABLE semantic_internal.identity_observation
  ADD COLUMN IF NOT EXISTS corroborating_scope_ref jsonb;

CREATE OR REPLACE FUNCTION semantic_internal.identity_scope_ref_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
  SELECT jsonb_typeof(value)='object'
     AND jsonb_typeof(value->'source_object_type')='string'
     AND jsonb_typeof(value->'source_record_id')='string'
     AND length(btrim(value->>'source_object_type')) BETWEEN 1 AND 160
     AND length(btrim(value->>'source_record_id')) BETWEEN 1 AND 500
     AND (SELECT count(*) FROM jsonb_object_keys(value))=2
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid='semantic_internal.identity_observation'::regclass
       AND conname='identity_observation_scope_ref_valid'
  ) THEN
    ALTER TABLE semantic_internal.identity_observation
      ADD CONSTRAINT identity_observation_scope_ref_valid
      CHECK (
        corroborating_scope_ref IS NULL
        OR semantic_internal.identity_scope_ref_valid(corroborating_scope_ref)
      );
  END IF;
END $$;

COMMENT ON COLUMN semantic_internal.identity_observation.corroborating_scope_ref IS
  'Same-connection source location reference used to derive source-neutral corroborating identity evidence.';

CREATE INDEX IF NOT EXISTS identity_observation_active_source_ref_idx
  ON semantic_internal.identity_observation(
    tenant_id,entity_type,connection_id,source_object_type,source_record_id
  ) WHERE active;

CREATE OR REPLACE FUNCTION semantic_internal.refresh_identity_scope_digests(p_tenant_id text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,core,semantic_internal
AS $$
DECLARE updated_count bigint;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;

  WITH calculated AS MATERIALIZED (
    SELECT subject.observation_id,
      CASE
        -- Accepted location identity edges project every member onto the same
        -- resolved canonical location ID. Hashing that ID is source-neutral.
        WHEN location_resolution.resolved_entity_id IS NOT NULL THEN
          md5('identity-scope-a|'||location_resolution.resolved_entity_id)
          ||md5('identity-scope-b|'||location_resolution.resolved_entity_id)
        -- Before a location decision, an exact normalized name+address key is
        -- sufficient corroboration for a review-only worker suggestion.
        WHEN location_evidence.deterministic_key_digests->>'location_name_address'
             ~ '^[a-f0-9]{64}$' THEN
          location_evidence.deterministic_key_digests->>'location_name_address'
        ELSE NULL
      END AS neutral_scope_digest
    FROM semantic_internal.identity_observation AS subject
    LEFT JOIN semantic_internal.canonical_record_state AS location_native
      ON location_native.tenant_id=subject.tenant_id
     AND location_native.canonical_table='location'
     AND location_native.connection_id=subject.connection_id
     AND location_native.source_object_type=subject.corroborating_scope_ref->>'source_object_type'
     AND location_native.source_record_id=subject.corroborating_scope_ref->>'source_record_id'
    LEFT JOIN core.entity_resolution AS location_resolution
      ON location_resolution.tenant_id=subject.tenant_id
     AND location_resolution.entity_type='location'
     AND location_resolution.member_entity_id=location_native.canonical_id
    LEFT JOIN semantic_internal.identity_observation AS location_evidence
      ON location_evidence.tenant_id=subject.tenant_id
     AND location_evidence.entity_type='location'
     AND location_evidence.connection_id=subject.connection_id
     AND location_evidence.source_object_type=subject.corroborating_scope_ref->>'source_object_type'
     AND location_evidence.source_record_id=subject.corroborating_scope_ref->>'source_record_id'
     AND location_evidence.active
    WHERE subject.tenant_id=p_tenant_id
      AND subject.corroborating_scope_ref IS NOT NULL
  )
  UPDATE semantic_internal.identity_observation AS subject
     SET corroborating_scope_digest=calculated.neutral_scope_digest
    FROM calculated
   WHERE subject.tenant_id=p_tenant_id
     AND subject.observation_id=calculated.observation_id
     AND subject.corroborating_scope_digest IS DISTINCT FROM calculated.neutral_scope_digest;

  GET DIAGNOSTICS updated_count=ROW_COUNT;
  RETURN updated_count;
END;
$$;

REVOKE ALL ON FUNCTION semantic_internal.identity_scope_ref_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION semantic_internal.refresh_identity_scope_digests(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION semantic_internal.identity_scope_ref_valid(jsonb) TO transform_rw;
GRANT EXECUTE ON FUNCTION semantic_internal.refresh_identity_scope_digests(text) TO transform_rw;

COMMIT;
