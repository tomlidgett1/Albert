BEGIN;

-- The managed PostgREST surface intentionally exposes only public and
-- graphql_public. Semantic authoring state remains in control_plane and is
-- projected through narrow, operator-gated RPCs instead of exposing the whole
-- schema through the Data API.

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_admin_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;

  RETURN jsonb_build_object(
    'drafts',(
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.updated_at DESC),'[]'::jsonb)
      FROM (
        SELECT draft_id,name,revision,status,manifest_hash,updated_at
        FROM control_plane.semantic_v2_drafts
        ORDER BY updated_at DESC
        LIMIT 30
      ) item
    ),
    'draftCount',(SELECT count(*) FROM control_plane.semantic_v2_drafts),
    'active',(
      SELECT to_jsonb(item)
      FROM (
        SELECT publication_hash,previous_publication_hash,activated_at
        FROM control_plane.semantic_v2_active_publication
        WHERE singleton
      ) item
    ),
    'publications',(
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.created_at DESC),'[]'::jsonb)
      FROM (
        SELECT publication_hash,registry_version,object_counts,source_draft_id,
          source_draft_revision,created_at
        FROM control_plane.semantic_v2_publications
        ORDER BY created_at DESC
        LIMIT 30
      ) item
    ),
    'qualifications',(
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.created_at DESC),'[]'::jsonb)
      FROM (
        SELECT publication_hash,commit_sha,status,created_at
        FROM control_plane.semantic_v2_activation_qualifications
        ORDER BY created_at DESC
        LIMIT 30
      ) item
    ),
    'validations',(
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.created_at DESC),'[]'::jsonb)
      FROM (
        SELECT validation_id,draft_id,draft_revision,manifest_hash,status,issues,
          deterministic_test_receipt,created_at
        FROM control_plane.semantic_v2_validation_reports
        ORDER BY created_at DESC
        LIMIT 60
      ) item
    ),
    'reviews',(
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.created_at DESC),'[]'::jsonb)
      FROM (
        SELECT draft_id,draft_revision,object_id,risk_tier,disposition,reviewer_id,created_at
        FROM control_plane.semantic_v2_object_reviews
        ORDER BY created_at DESC
        LIMIT 500
      ) item
    ),
    'profileReceipts',(
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.created_at DESC),'[]'::jsonb)
      FROM (
        SELECT profile_receipt_hash,publication_hash,tenant_digest,status,created_at
        FROM control_plane.semantic_v2_profile_receipts
        ORDER BY created_at DESC
        LIMIT 100
      ) item
    ),
    'contextValues',(
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.context_key),'[]'::jsonb)
      FROM (
        SELECT context_id,context_key,version,value,source,evidence,valid_from
        FROM control_plane.business_context_v2
        WHERE valid_to IS NULL
        ORDER BY context_key
        LIMIT 500
      ) item
    ),
    'runtimeEvents',(
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.created_at DESC),'[]'::jsonb)
      FROM (
        SELECT event_id,turn_id,publication_hash,event_kind,reason_code,question_digest,
          topic_ids,object_ids,detail,created_at
        FROM control_plane.semantic_runtime_events_v2
        ORDER BY created_at DESC
        LIMIT 500
      ) item
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_admin_profile_receipt(
  p_profile_receipt_hash text DEFAULT NULL,
  p_publication_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  IF (p_profile_receipt_hash IS NULL)=(p_publication_hash IS NULL) THEN
    RAISE EXCEPTION 'select exactly one profile receipt identity' USING ERRCODE='22023';
  END IF;

  SELECT jsonb_build_object(
    'profile_receipt_hash',receipt.profile_receipt_hash,
    'publication_hash',receipt.publication_hash,
    'tenant_digest',receipt.tenant_digest,
    'status',receipt.status,
    'artifact',receipt.artifact,
    'created_at',receipt.created_at
  ) INTO v_result
  FROM control_plane.semantic_v2_profile_receipts receipt
  WHERE (p_profile_receipt_hash IS NOT NULL AND receipt.profile_receipt_hash=p_profile_receipt_hash)
     OR (p_publication_hash IS NOT NULL AND receipt.publication_hash=p_publication_hash AND receipt.status='complete')
  ORDER BY receipt.created_at DESC
  LIMIT 1;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_admin_load_draft(p_draft_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object(
    'draft_id',draft.draft_id,
    'base_publication_hash',draft.base_publication_hash,
    'revision',draft.revision,
    'manifest',draft.manifest,
    'manifest_hash',draft.manifest_hash,
    'status',draft.status
  ) INTO v_result
  FROM control_plane.semantic_v2_drafts draft
  WHERE draft.draft_id=p_draft_id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_admin_load_publication(p_publication_hash text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object('publication_hash',publication.publication_hash,'artifact',publication.artifact)
  INTO v_result
  FROM control_plane.semantic_v2_publications publication
  WHERE publication.publication_hash=p_publication_hash;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_admin_load_initial_revision(p_draft_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object(
    'manifest',revision.manifest,
    'manifest_hash',revision.manifest_hash,
    'revision',revision.revision
  ) INTO v_result
  FROM control_plane.semantic_v2_draft_revisions revision
  WHERE revision.draft_id=p_draft_id
  ORDER BY revision.revision
  LIMIT 1;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_create_draft_from_current(
  p_draft_id text,
  p_name text,
  p_manifest jsonb,
  p_manifest_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM control_plane.semantic_v2_active_publication WHERE singleton) THEN
    RETURN public.albert_semantic_v2_create_draft_from_active(p_draft_id,p_name);
  END IF;
  RETURN public.albert_semantic_v2_create_draft(p_draft_id,p_name,p_manifest,p_manifest_hash);
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_semantic_v2_admin_register_profile_receipt(
  p_profile_receipt_hash text,
  p_publication_hash text,
  p_tenant_digest text,
  p_status text,
  p_artifact jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,control_plane
AS $$
DECLARE v_inserted integer;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  IF p_artifact->>'publicationHash' IS DISTINCT FROM p_publication_hash
     OR p_artifact->>'tenantDigest' IS DISTINCT FROM p_tenant_digest
     OR p_artifact->>'status' IS DISTINCT FROM p_status THEN
    RAISE EXCEPTION 'profile receipt envelope does not match its artifact' USING ERRCODE='22023';
  END IF;
  INSERT INTO control_plane.semantic_v2_profile_receipts(
    profile_receipt_hash,publication_hash,tenant_digest,status,artifact,created_by
  ) VALUES (
    p_profile_receipt_hash,p_publication_hash,p_tenant_digest,p_status,p_artifact,extensions.albert_auth_uid()
  ) ON CONFLICT (profile_receipt_hash) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  RETURN jsonb_build_object(
    'profileReceiptHash',p_profile_receipt_hash,
    'publicationHash',p_publication_hash,
    'status',p_status,
    'inserted',v_inserted=1
  );
END;
$$;

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
DECLARE v_draft control_plane.semantic_v2_drafts%ROWTYPE;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access is required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_draft FROM control_plane.semantic_v2_drafts WHERE draft_id=p_draft_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'semantic draft not found' USING ERRCODE='P0002'; END IF;
  IF v_draft.revision<>p_expected_revision THEN
    RAISE EXCEPTION 'semantic draft revision conflict' USING ERRCODE='40001';
  END IF;
  IF v_draft.manifest_hash<>p_manifest_hash THEN
    RAISE EXCEPTION 'validation manifest does not match the draft' USING ERRCODE='22000';
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
    'status',p_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.albert_semantic_v2_admin_state() FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_admin_profile_receipt(text,text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_admin_load_draft(text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_admin_load_publication(text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_admin_load_initial_revision(text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_create_draft_from_current(text,text,jsonb,text) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_admin_register_profile_receipt(text,text,text,text,jsonb) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.albert_semantic_v2_admin_record_validation(text,text,integer,text,text,jsonb,jsonb) FROM PUBLIC,anon,service_role;

GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_admin_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_admin_profile_receipt(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_admin_load_draft(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_admin_load_publication(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_admin_load_initial_revision(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_create_draft_from_current(text,text,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_admin_register_profile_receipt(text,text,text,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_semantic_v2_admin_record_validation(text,text,integer,text,text,jsonb,jsonb) TO authenticated;

COMMIT;
