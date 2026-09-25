BEGIN;

-- Validation reports are immutable and unique for one exact draft revision.
-- Replaying the same deterministic validation must therefore return the
-- existing report rather than surfacing its uniqueness constraint as a 503.
-- Locking the draft serializes concurrent first-writer attempts without
-- weakening the immutable report table.

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_admin_record_validation(
  p_validation_id text,
  p_draft_id text,
  p_expected_revision integer,
  p_manifest_hash text,
  p_status text,
  p_issues jsonb,
  p_deterministic_test_receipt jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE
  v_draft control_plane.semantic_v2_drafts%ROWTYPE;
  v_existing control_plane.semantic_v2_validation_reports%ROWTYPE;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_draft
  FROM control_plane.semantic_v2_drafts
  WHERE draft_id=p_draft_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'semantic draft not found' USING ERRCODE='P0002';
  END IF;
  IF v_draft.revision<>p_expected_revision THEN
    RAISE EXCEPTION 'semantic draft revision conflict' USING ERRCODE='40001';
  END IF;
  IF v_draft.manifest_hash<>p_manifest_hash THEN
    RAISE EXCEPTION 'validation manifest does not match the draft' USING ERRCODE='22000';
  END IF;

  SELECT * INTO v_existing
  FROM control_plane.semantic_v2_validation_reports
  WHERE draft_id=p_draft_id
    AND draft_revision=p_expected_revision
    AND manifest_hash=p_manifest_hash;
  IF FOUND THEN
    IF v_existing.status<>p_status
       OR v_existing.issues<>p_issues
       OR v_existing.deterministic_test_receipt<>p_deterministic_test_receipt THEN
      RAISE EXCEPTION 'the immutable validation replay does not match the existing report'
        USING ERRCODE='22000';
    END IF;
    RETURN jsonb_build_object(
      'validationId',v_existing.validation_id,
      'draftId',v_existing.draft_id,
      'revision',v_existing.draft_revision,
      'manifestHash',v_existing.manifest_hash,
      'status',v_existing.status,
      'idempotentReplay',true
    );
  END IF;

  INSERT INTO control_plane.semantic_v2_validation_reports(
    validation_id,draft_id,draft_revision,manifest_hash,status,issues,
    deterministic_test_receipt,created_by
  ) VALUES (
    p_validation_id,p_draft_id,p_expected_revision,p_manifest_hash,p_status,p_issues,
    p_deterministic_test_receipt,extensions.albert_auth_uid()
  );
  RETURN jsonb_build_object(
    'validationId',p_validation_id,
    'draftId',p_draft_id,
    'revision',p_expected_revision,
    'manifestHash',p_manifest_hash,
    'status',p_status,
    'idempotentReplay',false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.albert_semantic_v2_admin_record_validation(
  text,text,integer,text,text,jsonb,jsonb
) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_admin_record_validation(
  text,text,integer,text,text,jsonb,jsonb
) TO authenticated;

COMMIT;
