BEGIN;

-- Candidate generation used to materialize every active observation and then
-- self-join the entire tenant behind JSONB OR predicates. A single-source
-- tenant therefore performed quadratic work even though a cross-source match
-- was impossible. Flatten deterministic keys once and join each rung of the
-- matching ladder by equality instead.
CREATE INDEX IF NOT EXISTS canonical_record_state_source_identity_idx
  ON semantic_internal.canonical_record_state (
    tenant_id,canonical_table,connection_id,source_object_type,source_record_id
  );

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

  -- Identity suggestions are cross-source by definition. This bounded index
  -- scan is the overwhelmingly common fast path while a tenant has only one
  -- connection capable of producing a given entity type.
  IF NOT EXISTS (
    SELECT 1
      FROM semantic_internal.identity_observation
     WHERE tenant_id=p_tenant_id
       AND active
       AND linkable
     GROUP BY entity_type
    HAVING min(connection_id)<>max(connection_id)
  ) THEN
    RETURN 0;
  END IF;

  WITH subjects AS MATERIALIZED (
    SELECT
      observation_id,
      entity_type,
      connection_id,
      source_object_type,
      source_record_id,
      external_id_digest,
      deterministic_key_digests,
      normalized_name_digest,
      corroborating_scope_digest,
      evidence_refs
    FROM semantic_internal.identity_observation
    WHERE tenant_id=p_tenant_id
      AND active
      AND linkable
  ), available_keys AS (
    SELECT
      subject.observation_id,
      own.key,
      own.value
    FROM subjects AS subject
    CROSS JOIN LATERAL jsonb_each_text(subject.deterministic_key_digests)
      AS own(key,value)

    UNION ALL

    SELECT
      subject.observation_id,
      inherited.key,
      inherited.value
    FROM subjects AS subject
    CROSS JOIN LATERAL jsonb_array_elements(subject.evidence_refs)
      AS reference(value)
    JOIN semantic_internal.identity_observation AS evidence
      ON evidence.tenant_id=p_tenant_id
     AND evidence.entity_type=subject.entity_type
     AND evidence.connection_id=subject.connection_id
     AND evidence.source_object_type=reference.value->>'source_object_type'
     AND evidence.source_record_id=reference.value->>'source_record_id'
     AND evidence.active
    CROSS JOIN LATERAL jsonb_each_text(evidence.deterministic_key_digests)
      AS inherited(key,value)
  ), effective_keys AS MATERIALIZED (
    SELECT
      available.observation_id,
      available.key,
      min(available.value) AS value
    FROM available_keys AS available
    GROUP BY available.observation_id,available.key
    -- Conflicting lookup evidence must never create a deterministic match.
    HAVING count(DISTINCT available.value)=1
  ), external_pairs AS MATERIALIZED (
    SELECT
      left_row.observation_id AS left_observation_id,
      right_row.observation_id AS right_observation_id
    FROM subjects AS left_row
    JOIN subjects AS right_row
      ON right_row.entity_type=left_row.entity_type
     AND right_row.connection_id>left_row.connection_id
     AND right_row.external_id_digest=left_row.external_id_digest
    WHERE left_row.external_id_digest IS NOT NULL
  ), deterministic_pairs AS MATERIALIZED (
    SELECT DISTINCT
      left_row.observation_id AS left_observation_id,
      right_row.observation_id AS right_observation_id
    FROM effective_keys AS left_key
    JOIN effective_keys AS right_key
      ON right_key.key=left_key.key
     AND right_key.value=left_key.value
    JOIN subjects AS left_row
      ON left_row.observation_id=left_key.observation_id
    JOIN subjects AS right_row
      ON right_row.observation_id=right_key.observation_id
     AND right_row.entity_type=left_row.entity_type
     AND right_row.connection_id>left_row.connection_id
    LEFT JOIN external_pairs AS external_pair
      ON external_pair.left_observation_id=left_row.observation_id
     AND external_pair.right_observation_id=right_row.observation_id
    WHERE external_pair.left_observation_id IS NULL
  ), composite_pairs AS MATERIALIZED (
    SELECT
      left_row.observation_id AS left_observation_id,
      right_row.observation_id AS right_observation_id
    FROM subjects AS left_row
    JOIN subjects AS right_row
      ON right_row.entity_type=left_row.entity_type
     AND right_row.connection_id>left_row.connection_id
     AND right_row.normalized_name_digest=left_row.normalized_name_digest
     AND right_row.corroborating_scope_digest=left_row.corroborating_scope_digest
    LEFT JOIN external_pairs AS external_pair
      ON external_pair.left_observation_id=left_row.observation_id
     AND external_pair.right_observation_id=right_row.observation_id
    LEFT JOIN deterministic_pairs AS deterministic_pair
      ON deterministic_pair.left_observation_id=left_row.observation_id
     AND deterministic_pair.right_observation_id=right_row.observation_id
    WHERE left_row.normalized_name_digest IS NOT NULL
      AND left_row.corroborating_scope_digest IS NOT NULL
      AND external_pair.left_observation_id IS NULL
      AND deterministic_pair.left_observation_id IS NULL
  ), candidate_pairs AS (
    SELECT left_observation_id,right_observation_id,'external_id'::text AS method
      FROM external_pairs
    UNION ALL
    SELECT left_observation_id,right_observation_id,'deterministic_key'::text AS method
      FROM deterministic_pairs
    UNION ALL
    SELECT left_observation_id,right_observation_id,'composite_suggestion'::text AS method
      FROM composite_pairs
  ), candidates AS (
    SELECT
      left_row.entity_type,
      left_row.connection_id AS left_connection_id,
      left_row.source_object_type AS left_object_type,
      left_row.source_record_id AS left_record_id,
      right_row.connection_id AS right_connection_id,
      right_row.source_object_type AS right_object_type,
      right_row.source_record_id AS right_record_id,
      pair.method
    FROM candidate_pairs AS pair
    JOIN subjects AS left_row
      ON left_row.observation_id=pair.left_observation_id
    JOIN subjects AS right_row
      ON right_row.observation_id=pair.right_observation_id
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

COMMENT ON FUNCTION semantic_internal.generate_identity_review_candidates(text) IS
  'Generates conservative cross-source identity review candidates with a single-source fast return and set-based equality joins.';

REVOKE ALL ON FUNCTION semantic_internal.generate_identity_review_candidates(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION semantic_internal.generate_identity_review_candidates(text) TO transform_rw;

COMMIT;
