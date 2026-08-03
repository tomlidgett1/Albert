BEGIN;

-- Lookup records such as a contact resource may carry identity evidence for a
-- canonical subject without themselves being canonical entities. The pack
-- declares that association; the matcher remains source-neutral.
ALTER TABLE semantic_internal.identity_observation
  ADD COLUMN IF NOT EXISTS evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS linkable boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION semantic_internal.identity_evidence_refs_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(value)>16 THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(value) AS item(reference)
       WHERE CASE
         WHEN jsonb_typeof(item.reference) IS DISTINCT FROM 'object' THEN true
         ELSE jsonb_typeof(item.reference->'source_object_type') IS DISTINCT FROM 'string'
           OR jsonb_typeof(item.reference->'source_record_id') IS DISTINCT FROM 'string'
           OR length(btrim(item.reference->>'source_object_type')) NOT BETWEEN 1 AND 160
           OR length(btrim(item.reference->>'source_record_id')) NOT BETWEEN 1 AND 500
           OR (SELECT count(*) FROM jsonb_object_keys(item.reference))<>2
       END
    )
  END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid='semantic_internal.identity_observation'::regclass
       AND conname='identity_observation_evidence_refs_valid'
  ) THEN
    ALTER TABLE semantic_internal.identity_observation
      ADD CONSTRAINT identity_observation_evidence_refs_valid
      CHECK (semantic_internal.identity_evidence_refs_valid(evidence_refs));
  END IF;
END $$;

COMMENT ON COLUMN semantic_internal.identity_observation.evidence_refs IS
  'Bounded same-tenant, same-connection source identities whose active deterministic evidence enriches this subject.';
COMMENT ON COLUMN semantic_internal.identity_observation.linkable IS
  'False for lookup evidence that may enrich a subject but must never become a review-card candidate itself.';

-- Build effective subject observations by merging only unambiguous key/value
-- digests from active, explicitly referenced lookup observations. Candidate
-- links always use the source-owned canonical ID recorded by the transform;
-- graph representatives are intentionally absent so A-B cannot erase a later
-- transitive-safe B-C review candidate.
CREATE OR REPLACE FUNCTION semantic_internal.generate_identity_review_candidates(p_tenant_id text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,core,semantic_internal
AS $$
DECLARE inserted_count bigint;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;

  WITH effective_observations AS MATERIALIZED (
    SELECT
      subject.tenant_id,
      subject.entity_type,
      subject.connection_id,
      subject.source_object_type,
      subject.source_record_id,
      subject.external_id_digest,
      coalesce(effective.keys,'{}'::jsonb) AS deterministic_key_digests,
      subject.normalized_name_digest,
      subject.corroborating_scope_digest
    FROM semantic_internal.identity_observation AS subject
    LEFT JOIN LATERAL (
      SELECT jsonb_object_agg(unambiguous.key,unambiguous.value ORDER BY unambiguous.key) AS keys
      FROM (
        SELECT available.key,min(available.value) AS value
        FROM (
          SELECT own.key,own.value
            FROM jsonb_each_text(subject.deterministic_key_digests) AS own(key,value)
          UNION ALL
          SELECT inherited.key,inherited.value
            FROM jsonb_array_elements(subject.evidence_refs) AS reference(value)
            JOIN semantic_internal.identity_observation AS evidence
              ON evidence.tenant_id=subject.tenant_id
             AND evidence.entity_type=subject.entity_type
             AND evidence.connection_id=subject.connection_id
             AND evidence.source_object_type=reference.value->>'source_object_type'
             AND evidence.source_record_id=reference.value->>'source_record_id'
             AND evidence.active
            CROSS JOIN LATERAL jsonb_each_text(evidence.deterministic_key_digests)
              AS inherited(key,value)
        ) AS available
        GROUP BY available.key
        HAVING count(DISTINCT available.value)=1
      ) AS unambiguous
    ) AS effective ON true
    WHERE subject.tenant_id=p_tenant_id
      AND subject.active
      AND subject.linkable
  ), candidates AS (
    SELECT
      left_row.entity_type,
      left_row.connection_id AS left_connection_id,
      left_row.source_object_type AS left_object_type,
      left_row.source_record_id AS left_record_id,
      right_row.connection_id AS right_connection_id,
      right_row.source_object_type AS right_object_type,
      right_row.source_record_id AS right_record_id,
      CASE
        WHEN left_row.external_id_digest IS NOT NULL
         AND left_row.external_id_digest=right_row.external_id_digest THEN 'external_id'
        WHEN EXISTS (
          SELECT 1
            FROM jsonb_each_text(left_row.deterministic_key_digests) AS left_key(key,value)
            JOIN jsonb_each_text(right_row.deterministic_key_digests) AS right_key(key,value)
              ON right_key.key=left_key.key AND right_key.value=left_key.value
        ) THEN 'deterministic_key'
        ELSE 'composite_suggestion'
      END AS method
    FROM effective_observations AS left_row
    JOIN effective_observations AS right_row
      ON right_row.tenant_id=left_row.tenant_id
     AND right_row.entity_type=left_row.entity_type
     AND right_row.connection_id>left_row.connection_id
    WHERE
      (left_row.external_id_digest IS NOT NULL
       AND left_row.external_id_digest=right_row.external_id_digest)
      OR EXISTS (
        SELECT 1
          FROM jsonb_each_text(left_row.deterministic_key_digests) AS left_key(key,value)
          JOIN jsonb_each_text(right_row.deterministic_key_digests) AS right_key(key,value)
            ON right_key.key=left_key.key AND right_key.value=left_key.value
      )
      OR (
        left_row.normalized_name_digest IS NOT NULL
        AND left_row.normalized_name_digest=right_row.normalized_name_digest
        AND left_row.corroborating_scope_digest IS NOT NULL
        AND left_row.corroborating_scope_digest=right_row.corroborating_scope_digest
      )
  ), linked AS (
    SELECT candidate.*,
      left_native.canonical_id AS left_entity_id,
      right_native.canonical_id AS right_entity_id,
      md5('identity-review-a|'||concat_ws('|',candidate.entity_type,
        candidate.left_connection_id,candidate.left_object_type,candidate.left_record_id,
        candidate.right_connection_id,candidate.right_object_type,candidate.right_record_id,
        candidate.method))
      ||md5('identity-review-b|'||concat_ws('|',candidate.entity_type,
        candidate.left_connection_id,candidate.left_object_type,candidate.left_record_id,
        candidate.right_connection_id,candidate.right_object_type,candidate.right_record_id,
        candidate.method)) AS suggestion_key
    FROM candidates AS candidate
    JOIN semantic_internal.canonical_record_state AS left_native
      ON left_native.tenant_id=p_tenant_id
     AND left_native.canonical_table=candidate.entity_type
     AND left_native.connection_id=candidate.left_connection_id
     AND left_native.source_object_type=candidate.left_object_type
     AND left_native.source_record_id=candidate.left_record_id
    JOIN semantic_internal.canonical_record_state AS right_native
      ON right_native.tenant_id=p_tenant_id
     AND right_native.canonical_table=candidate.entity_type
     AND right_native.connection_id=candidate.right_connection_id
     AND right_native.source_object_type=candidate.right_object_type
     AND right_native.source_record_id=candidate.right_record_id
    JOIN core.entity_source_link AS left_link
      ON left_link.tenant_id=p_tenant_id
     AND left_link.entity_type=candidate.entity_type
     AND left_link.connection_id=candidate.left_connection_id
     AND left_link.source_object_type=candidate.left_object_type
     AND left_link.source_record_id=candidate.left_record_id
     AND left_link.canonical_entity_id=left_native.canonical_id
     AND left_link.match_status='accepted'
     AND left_link.valid_to IS NULL
    JOIN core.entity_source_link AS right_link
      ON right_link.tenant_id=p_tenant_id
     AND right_link.entity_type=candidate.entity_type
     AND right_link.connection_id=candidate.right_connection_id
     AND right_link.source_object_type=candidate.right_object_type
     AND right_link.source_record_id=candidate.right_record_id
     AND right_link.canonical_entity_id=right_native.canonical_id
     AND right_link.match_status='accepted'
     AND right_link.valid_to IS NULL
    WHERE left_native.canonical_id<>right_native.canonical_id
  ), labelled AS (
    SELECT linked.*,
      CASE linked.entity_type
        WHEN 'worker' THEN (SELECT display_name FROM core.worker WHERE tenant_id=p_tenant_id AND id=linked.left_entity_id)
        WHEN 'location' THEN (SELECT name FROM core.location WHERE tenant_id=p_tenant_id AND id=linked.left_entity_id)
        WHEN 'product_variant' THEN (SELECT name FROM core.product_variant WHERE tenant_id=p_tenant_id AND id=linked.left_entity_id)
        WHEN 'customer_account' THEN (SELECT display_name FROM core.customer_account WHERE tenant_id=p_tenant_id AND id=linked.left_entity_id)
        WHEN 'supplier' THEN (SELECT name FROM core.supplier WHERE tenant_id=p_tenant_id AND id=linked.left_entity_id)
      END AS left_label,
      CASE linked.entity_type
        WHEN 'worker' THEN (SELECT display_name FROM core.worker WHERE tenant_id=p_tenant_id AND id=linked.right_entity_id)
        WHEN 'location' THEN (SELECT name FROM core.location WHERE tenant_id=p_tenant_id AND id=linked.right_entity_id)
        WHEN 'product_variant' THEN (SELECT name FROM core.product_variant WHERE tenant_id=p_tenant_id AND id=linked.right_entity_id)
        WHEN 'customer_account' THEN (SELECT display_name FROM core.customer_account WHERE tenant_id=p_tenant_id AND id=linked.right_entity_id)
        WHEN 'supplier' THEN (SELECT name FROM core.supplier WHERE tenant_id=p_tenant_id AND id=linked.right_entity_id)
      END AS right_label
    FROM linked
  )
  INSERT INTO semantic_internal.identity_review_projection_outbox (
    tenant_id,projection_id,task_id,suggestion_key,entity_type,confidence_band,
    candidate_links,evidence
  )
  SELECT p_tenant_id,
    semantic_internal.deterministic_ulid('identity-projection|'||p_tenant_id||'|'||suggestion_key),
    semantic_internal.deterministic_ulid('identity-task|'||p_tenant_id||'|'||suggestion_key),
    suggestion_key,entity_type,
    CASE WHEN method='composite_suggestion' THEN 'medium' ELSE 'high' END,
    jsonb_build_array(
      jsonb_build_object(
        'canonical_entity_id',left_entity_id,'connection_id',left_connection_id,
        'source_object_type',left_object_type,'source_record_id',left_record_id,
        'label',coalesce(left_label,left_record_id)
      ),
      jsonb_build_object(
        'canonical_entity_id',right_entity_id,'connection_id',right_connection_id,
        'source_object_type',right_object_type,'source_record_id',right_record_id,
        'label',coalesce(right_label,right_record_id)
      )
    ),
    jsonb_build_object(
      'suggestion_key',suggestion_key,'match_method',method,
      'summary',CASE WHEN method='composite_suggestion'
        THEN 'Normalized name and confirmed organisational scope match.'
        ELSE 'A deterministic cross-source identity key matches.' END
    )
  FROM labelled
  ON CONFLICT (tenant_id,suggestion_key) DO NOTHING;

  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION semantic_internal.identity_evidence_refs_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION semantic_internal.generate_identity_review_candidates(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION semantic_internal.identity_evidence_refs_valid(jsonb) TO transform_rw;
GRANT EXECUTE ON FUNCTION semantic_internal.generate_identity_review_candidates(text) TO transform_rw;

COMMIT;
