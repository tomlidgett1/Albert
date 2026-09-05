BEGIN;

-- An explicit owner risk acceptance can replace only the second independent
-- Tier-1 semantic reviewer or the subjective human evaluation score. It is
-- exact-release evidence: immutable, content-addressed and unusable for any
-- other draft, publication, commit or evaluation run. Machine correctness,
-- isolation, fan-out, evidence and deterministic validation remain mandatory.
CREATE TABLE control_plane.semantic_v2_owner_review_waivers (
  waiver_digest text PRIMARY KEY CHECK (waiver_digest~'^[a-f0-9]{64}$'),
  scope text NOT NULL CHECK (scope IN (
    'semantic_publication_tier_1_second_review',
    'evaluation_subjective_human_review'
  )),
  draft_id text,
  draft_revision integer CHECK (draft_revision IS NULL OR draft_revision>0),
  publication_hash text NOT NULL CHECK (publication_hash~'^[a-f0-9]{64}$'),
  commit_sha text CHECK (commit_sha IS NULL OR commit_sha~'^[a-f0-9]{40}$'),
  run_id text CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 160),
  reason text NOT NULL CHECK (length(reason) BETWEEN 20 AND 2000),
  artifact jsonb NOT NULL CHECK (jsonb_typeof(artifact)='object'),
  authorized_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (artifact->>'waiverDigest'=waiver_digest),
  CHECK (artifact->>'kind'='albert.semantic-v2-owner-review-waiver'),
  CHECK (artifact->>'status'='authorized'),
  CHECK (artifact->>'scope'=scope),
  CHECK (artifact->>'publicationHash'=publication_hash),
  CHECK (artifact->>'authorizedBy'=authorized_by::text),
  CHECK (artifact->>'reason'=reason),
  CHECK (
    (scope='semantic_publication_tier_1_second_review'
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
  )
);

CREATE UNIQUE INDEX semantic_v2_owner_review_waivers_publication_binding
  ON control_plane.semantic_v2_owner_review_waivers(
    scope,draft_id,draft_revision,publication_hash
  )
  WHERE scope='semantic_publication_tier_1_second_review';
CREATE UNIQUE INDEX semantic_v2_owner_review_waivers_evaluation_binding
  ON control_plane.semantic_v2_owner_review_waivers(
    scope,publication_hash,commit_sha,run_id
  )
  WHERE scope='evaluation_subjective_human_review';

ALTER TABLE control_plane.semantic_v2_owner_review_waivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_owner_review_waivers FORCE ROW LEVEL SECURITY;
CREATE POLICY semantic_v2_owner_review_waivers_release_read
  ON control_plane.semantic_v2_owner_review_waivers
  FOR SELECT TO albert_control_migration_owner
  USING (true);
CREATE POLICY semantic_v2_owner_review_waivers_release_append
  ON control_plane.semantic_v2_owner_review_waivers
  FOR INSERT TO albert_control_migration_owner
  WITH CHECK (true);
CREATE POLICY semantic_v2_owner_review_waivers_internal_operator_read
  ON control_plane.semantic_v2_owner_review_waivers
  FOR SELECT TO authenticated
  USING (control_plane.is_internal_operator());
CREATE TRIGGER semantic_v2_owner_review_waivers_immutable
  BEFORE UPDATE OR DELETE ON control_plane.semantic_v2_owner_review_waivers
  FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();

REVOKE ALL ON control_plane.semantic_v2_owner_review_waivers
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON control_plane.semantic_v2_owner_review_waivers
  TO albert_control_migration_owner;
GRANT SELECT ON control_plane.semantic_v2_owner_review_waivers
  TO authenticated;

ALTER TABLE control_plane.semantic_v2_publications
  ADD COLUMN review_waiver_digest text
  REFERENCES control_plane.semantic_v2_owner_review_waivers(waiver_digest);

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

  SELECT waiver_digest INTO v_review_waiver_digest
  FROM control_plane.semantic_v2_owner_review_waivers
  WHERE scope='semantic_publication_tier_1_second_review'
    AND draft_id=p_draft_id
    AND draft_revision=p_expected_revision
    AND publication_hash=p_publication_hash;

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
      IF v_required_tier='tier_1'
         AND v_approvals<2
         AND NOT (v_approvals=1 AND v_review_waiver_digest IS NOT NULL) THEN
        RAISE EXCEPTION 'review requirements are not satisfied for %',v_object->>'id' USING ERRCODE='23514';
      END IF;
      IF v_required_tier='tier_1'
         AND v_approvals=1
         AND v_review_waiver_digest IS NOT NULL THEN
        v_review_waiver_used:=true;
      END IF;
      IF v_required_tier='tier_2' AND v_approvals<1 THEN
        RAISE EXCEPTION 'review requirements are not satisfied for %',v_object->>'id' USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  IF NOT v_review_waiver_used THEN
    v_review_waiver_digest:=NULL;
  END IF;
  v_review_disposition:=CASE
    WHEN v_review_waiver_digest IS NULL THEN 'independently_reviewed'
    ELSE 'owner_waived_second_review'
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
