BEGIN;

-- Blocking onboarding answers are semantic configuration, not an arbitrary
-- JSON write primitive.  The database owns the exact V1 question/option
-- allowlist and projects each answer into its operative overlay field.
CREATE OR REPLACE FUNCTION public.albert_answer_blocking_question(
  p_question_id text,
  p_option_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  actor uuid:=auth.uid();
  selected_tenant text:=control_plane.require_current_tenant_id();
  current_overlay control_plane.tenant_overlays%ROWTYPE;
  previous_response text;
  previous_option text;
  next_response_version integer;
  next_overlay jsonb;
BEGIN
  IF actor IS NULL OR NOT control_plane.has_tenant_role(
    selected_tenant,ARRAY['owner','manager']::text[]
  ) THEN
    RAISE EXCEPTION 'owner or manager role required' USING ERRCODE='42501';
  END IF;
  IF NOT (
    (p_question_id='sales-lens' AND p_option_id IN ('ex-gst','inc-gst'))
    OR (p_question_id='trading-day' AND p_option_id IN ('midnight','2am','4am'))
    OR (p_question_id='employee-performance' AND p_option_id IN ('net-sales','gross-profit','profit-per-hour'))
    OR (p_question_id='pos-posting-topology' AND p_option_id IN ('daily-summary','line-by-line','not-sure'))
  ) THEN
    RAISE EXCEPTION 'blocking question option is not allowlisted' USING ERRCODE='22023';
  END IF;

  SELECT * INTO current_overlay
    FROM control_plane.tenant_overlays AS overlay
   WHERE overlay.tenant_id=selected_tenant AND overlay.status='published'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'published tenant overlay is missing' USING ERRCODE='P0002';
  END IF;

  SELECT response.response_id,response.option_id,response.response_version+1
    INTO previous_response,previous_option,next_response_version
    FROM control_plane.onboarding_question_responses AS response
   WHERE response.tenant_id=selected_tenant
     AND response.question_id=p_question_id
   ORDER BY response.response_version DESC
   LIMIT 1;
  IF previous_option=p_option_id THEN
    RETURN;
  END IF;
  next_response_version:=coalesce(next_response_version,1);

  INSERT INTO control_plane.onboarding_question_responses (
    tenant_id,response_id,question_id,option_id,response_version,
    previous_response_id,answered_by
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),p_question_id,p_option_id,
    next_response_version,previous_response,actor
  );

  next_overlay:=current_overlay.overlay||jsonb_build_object(
    'blocking_answers',coalesce(current_overlay.overlay->'blocking_answers','{}'::jsonb),
    'remembered_preferences',coalesce(current_overlay.overlay->'remembered_preferences','{}'::jsonb)
  );
  next_overlay:=jsonb_set(
    next_overlay,ARRAY['blocking_answers',p_question_id],to_jsonb(p_option_id),true
  );

  CASE p_question_id
    WHEN 'sales-lens' THEN
      next_overlay:=jsonb_set(
        jsonb_set(
          next_overlay,ARRAY['tax_display_default'],
          to_jsonb(CASE p_option_id WHEN 'inc-gst' THEN 'inclusive' ELSE 'exclusive' END),true
        ),
        ARRAY['remembered_preferences','sales.default_metric'],
        to_jsonb(CASE p_option_id
          WHEN 'inc-gst' THEN 'commerce.gross_takings_inc_gst'
          ELSE 'commerce.net_sales_ex_gst'
        END),true
      );
    WHEN 'trading-day' THEN
      next_overlay:=jsonb_set(
        next_overlay,ARRAY['trading_day_cutoff'],
        to_jsonb(CASE p_option_id
          WHEN '2am' THEN '02:00'
          WHEN '4am' THEN '04:00'
          ELSE '00:00'
        END),true
      );
    WHEN 'employee-performance' THEN
      next_overlay:=jsonb_set(
        next_overlay,ARRAY['remembered_preferences','employee.performance_default'],
        to_jsonb(CASE p_option_id
          WHEN 'gross-profit' THEN 'commerce.gross_margin'
          WHEN 'profit-per-hour' THEN 'composites.sales_per_labour_hour'
          ELSE 'commerce.net_sales_ex_gst'
        END),true
      );
    WHEN 'pos-posting-topology' THEN
      next_overlay:=jsonb_set(
        next_overlay,ARRAY['remembered_preferences','reconciliation.pos_posting_topology'],
        to_jsonb(CASE p_option_id
          WHEN 'daily-summary' THEN 'daily_summary_journals'
          WHEN 'line-by-line' THEN 'individual_transactions'
          ELSE 'unknown'
        END),true
      );
  END CASE;

  UPDATE control_plane.tenant_overlays
     SET status='superseded',superseded_at=now()
   WHERE tenant_id=selected_tenant AND overlay_id=current_overlay.overlay_id;
  INSERT INTO control_plane.tenant_overlays (
    tenant_id,overlay_id,version,status,overlay,change_reason,
    created_by,published_at
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),current_overlay.version+1,
    'published',next_overlay,'Blocking question answered: '||p_question_id,
    actor,now()
  );
  INSERT INTO control_plane.audit_log (
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),actor,'user',
    'onboarding.blocking_question_answered','onboarding_question',p_question_id,
    jsonb_build_object(
      'option_id',p_option_id,
      'response_version',next_response_version,
      'overlay_version',current_overlay.version+1
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.albert_answer_blocking_question(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_answer_blocking_question(text,text) TO authenticated;

-- The semantic service receives only the current tenant's published, bounded
-- dossier so the agent can interpret questions in business context.  It does
-- not receive browser or cross-tenant dossier access.
GRANT SELECT ON TABLE control_plane.dossiers TO albert_semantic_control;
DROP POLICY IF EXISTS semantic_runtime_dossier_read ON control_plane.dossiers;
CREATE POLICY semantic_runtime_dossier_read
  ON control_plane.dossiers
  FOR SELECT TO albert_semantic_control
  USING (tenant_id=current_setting('albert.tenant_id',true));

COMMIT;
