BEGIN;

-- ADR 0082 also permits the product owner to disclose and accept the complete
-- absence of semantic human review for one exact draft. This is deliberately a
-- different scope from the narrower second-review waiver so the release
-- record cannot overstate what was reviewed. Validation and every compiler,
-- evidence and safety gate remain mandatory.
ALTER TABLE control_plane.semantic_v2_owner_review_waivers
  DROP CONSTRAINT semantic_v2_owner_review_waivers_scope_check;
ALTER TABLE control_plane.semantic_v2_owner_review_waivers
  ADD CONSTRAINT semantic_v2_owner_review_waivers_scope_check CHECK (scope IN (
    'semantic_publication_human_review',
    'semantic_publication_tier_1_second_review',
    'evaluation_subjective_human_review'
  ));

ALTER TABLE control_plane.semantic_v2_owner_review_waivers
  DROP CONSTRAINT semantic_v2_owner_review_waivers_check5;
ALTER TABLE control_plane.semantic_v2_owner_review_waivers
  ADD CONSTRAINT semantic_v2_owner_review_waivers_check5 CHECK (
    (scope IN (
        'semantic_publication_human_review',
        'semantic_publication_tier_1_second_review'
      )
      AND draft_id IS NOT NULL
      AND control_plane.is_ulid(draft_id)
      AND draft_revision IS NOT NULL
      AND commit_sha IS NULL
      AND run_id IS NULL
      AND artifact->>'draftId'=draft_id
      AND (artifact->>'draftRevision')::integer=draft_revision
      AND NOT (artifact ? 'commit')
      AND NOT (artifact ? 'runId'))
    OR
    (scope='evaluation_subjective_human_review'
      AND draft_id IS NULL
      AND draft_revision IS NULL
      AND commit_sha IS NOT NULL
      AND run_id IS NOT NULL
      AND artifact->>'commit'=commit_sha
      AND artifact->>'runId'=run_id
      AND NOT (artifact ? 'draftId')
      AND NOT (artifact ? 'draftRevision'))
  );

CREATE UNIQUE INDEX semantic_v2_owner_review_waivers_full_publication_binding
  ON control_plane.semantic_v2_owner_review_waivers(
    scope,draft_id,draft_revision,publication_hash
  )
  WHERE scope='semantic_publication_human_review';

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_publish_draft(
  p_draft_id text,
  p_expected_revision integer,
  p_validation_id text,
  p_publication_hash text,
  p_object_counts jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE
  v_draft control_plane.semantic_v2_drafts%ROWTYPE;
  v_validation control_plane.semantic_v2_validation_reports%ROWTYPE;
  v_object jsonb;
  v_approvals integer;
  v_required_tier text;
  v_review_waiver_digest text;
  v_review_waiver_scope text;
  v_review_waiver_used boolean:=false;
  v_review_disposition text;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_draft FROM control_plane.semantic_v2_drafts WHERE draft_id=p_draft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'semantic draft not found' USING ERRCODE='P0002'; END IF;
  IF v_draft.revision<>p_expected_revision THEN RAISE EXCEPTION 'semantic draft revision conflict' USING ERRCODE='40001'; END IF;
  IF v_draft.manifest_hash<>p_publication_hash THEN RAISE EXCEPTION 'publication hash does not match the draft manifest' USING ERRCODE='22000'; END IF;
  SELECT * INTO v_validation FROM control_plane.semantic_v2_validation_reports WHERE validation_id=p_validation_id;
  IF NOT FOUND OR v_validation.draft_id<>p_draft_id OR v_validation.draft_revision<>p_expected_revision
     OR v_validation.manifest_hash<>p_publication_hash OR v_validation.status<>'passed' THEN
    RAISE EXCEPTION 'a passing validation for the exact draft revision is required' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.semantic_v2_object_reviews
    WHERE draft_id=p_draft_id AND draft_revision=p_expected_revision AND disposition='changes_requested'
  ) THEN RAISE EXCEPTION 'requested review changes remain unresolved' USING ERRCODE='23514'; END IF;

  SELECT waiver_digest,scope INTO v_review_waiver_digest,v_review_waiver_scope
  FROM control_plane.semantic_v2_owner_review_waivers
  WHERE scope IN (
      'semantic_publication_human_review',
      'semantic_publication_tier_1_second_review'
    )
    AND draft_id=p_draft_id
    AND draft_revision=p_expected_revision
    AND publication_hash=p_publication_hash
  ORDER BY CASE scope
    WHEN 'semantic_publication_human_review' THEN 1
    ELSE 2
  END
  LIMIT 1;

  FOR v_object,v_required_tier IN
    SELECT object_value,required_tier
    FROM (
      SELECT value AS object_value,value->>'riskTier' AS required_tier
      FROM jsonb_array_elements(v_draft.manifest->'measures')
      WHERE value->>'semanticState' IN ('verified','derived') AND value->>'riskTier' IN ('tier_1','tier_2')
      UNION ALL
      SELECT value,'tier_1'
      FROM jsonb_array_elements(v_draft.manifest->'relationships')
      WHERE value->>'semanticState' IN ('verified','derived')
      UNION ALL
      SELECT value,'tier_1'
      FROM jsonb_array_elements(v_draft.manifest->'topics')
      WHERE value->>'layer'='composite' AND value->>'semanticState' IN ('verified','derived')
      UNION ALL
      SELECT field_value,'tier_1'
      FROM jsonb_array_elements(v_draft.manifest->'sourceObjects') source_value
      CROSS JOIN LATERAL jsonb_array_elements(source_value->'fields') field_value
      WHERE COALESCE((field_value->>'pii')::boolean,false)
         OR field_value->>'disposition'='sensitive_metadata'
    ) required_reviews
  LOOP
    IF v_required_tier IN ('tier_1','tier_2') THEN
      SELECT count(DISTINCT reviewer_id) INTO v_approvals
      FROM control_plane.semantic_v2_object_reviews
      WHERE draft_id=p_draft_id AND draft_revision=p_expected_revision
        AND object_id=v_object->>'id' AND risk_tier=v_required_tier AND disposition='approved';

      IF v_review_waiver_scope='semantic_publication_human_review' THEN
        IF (v_required_tier='tier_1' AND v_approvals<2)
           OR (v_required_tier='tier_2' AND v_approvals<1) THEN
          v_review_waiver_used:=true;
        END IF;
      ELSE
        IF v_required_tier='tier_1'
           AND v_approvals<2
           AND NOT (
             v_approvals=1
             AND v_review_waiver_scope='semantic_publication_tier_1_second_review'
           ) THEN
          RAISE EXCEPTION 'review requirements are not satisfied for %',v_object->>'id' USING ERRCODE='23514';
        END IF;
        IF v_required_tier='tier_1'
           AND v_approvals=1
           AND v_review_waiver_scope='semantic_publication_tier_1_second_review' THEN
          v_review_waiver_used:=true;
        END IF;
        IF v_required_tier='tier_2' AND v_approvals<1 THEN
          RAISE EXCEPTION 'review requirements are not satisfied for %',v_object->>'id' USING ERRCODE='23514';
        END IF;
      END IF;
    END IF;
  END LOOP;
  IF NOT v_review_waiver_used THEN
    v_review_waiver_digest:=NULL;
    v_review_waiver_scope:=NULL;
  END IF;
  v_review_disposition:=CASE v_review_waiver_scope
    WHEN 'semantic_publication_human_review' THEN 'owner_waived_human_review'
    WHEN 'semantic_publication_tier_1_second_review' THEN 'owner_waived_second_review'
    ELSE 'independently_reviewed'
  END;
  INSERT INTO control_plane.semantic_v2_publications(
    publication_hash,registry_version,schema_version,artifact,object_counts,
    validation_id,source_draft_id,source_draft_revision,created_by,review_waiver_digest
  ) VALUES (
    p_publication_hash,v_draft.manifest->>'registryVersion',2,
    jsonb_build_object(
      'schemaVersion',2,'registryVersion',v_draft.manifest->>'registryVersion',
      'publicationHash',p_publication_hash,'objectCounts',p_object_counts,'manifest',v_draft.manifest,
      'reviewDisposition',v_review_disposition,'reviewWaiverDigest',v_review_waiver_digest
    ),p_object_counts,p_validation_id,p_draft_id,p_expected_revision,extensions.albert_auth_uid(),v_review_waiver_digest
  ) ON CONFLICT (publication_hash) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.semantic_v2_publications
    WHERE publication_hash=p_publication_hash
      AND review_waiver_digest IS NOT DISTINCT FROM v_review_waiver_digest
  ) THEN
    RAISE EXCEPTION 'existing publication has a different review disposition' USING ERRCODE='23514';
  END IF;
  UPDATE control_plane.semantic_v2_drafts SET status='publishable',updated_at=now() WHERE draft_id=p_draft_id;
  RETURN jsonb_build_object(
    'publicationHash',p_publication_hash,
    'draftId',p_draft_id,
    'revision',p_expected_revision,
    'activationReady',false,
    'reviewDisposition',v_review_disposition,
    'reviewWaiverDigest',v_review_waiver_digest
  );
END;
$$;

COMMIT;
