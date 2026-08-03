BEGIN;

-- This is a candidate wording contract, not evidence of product-owner approval.
-- Production remains fail-closed until the protected environment explicitly
-- supplies this exact reviewed digest.
CREATE TABLE control_plane.blocking_question_contract (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  contract_version text NOT NULL UNIQUE
    CHECK (contract_version ~ '^albert-blocking-questions/[1-9][0-9]*$'),
  contract_digest text NOT NULL UNIQUE CHECK (contract_digest ~ '^[a-f0-9]{64}$'),
  contract_canonical_json text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((contract_canonical_json::jsonb ->> 'schemaVersion')::integer = 1),
  CHECK (contract_canonical_json::jsonb ->> 'contractVersion' = contract_version),
  CHECK (jsonb_typeof(contract_canonical_json::jsonb -> 'questions') = 'array'),
  CHECK (
    contract_digest = encode(
      extensions.digest(convert_to(contract_canonical_json, 'UTF8'), 'sha256'),
      'hex'
    )
  )
);

COMMENT ON TABLE control_plane.blocking_question_contract IS
  'Immutable installed snapshot of the code-owned, content-addressed onboarding wording and overlay mutation contract. It is not an approval record.';

INSERT INTO control_plane.blocking_question_contract (
  singleton,
  contract_version,
  contract_digest,
  contract_canonical_json
) VALUES (
  true,
  'albert-blocking-questions/1',
  'cbdd710ed6fae8bd811d646b00e5ae27345270d1a3375bcabb55ed9dc3796723',
  $blocking_questions${"contractVersion":"albert-blocking-questions/1","questions":[{"connectorPrerequisites":["lightspeed-r"],"id":"sales-lens","label":"Default sales lens","options":[{"id":"ex-gst","label":"Excluding GST","overlayMutations":[{"path":["tax_display_default"],"value":"exclusive"},{"path":["remembered_preferences","sales.default_metric"],"value":"commerce.net_sales_ex_gst"}]},{"id":"inc-gst","label":"Including GST","overlayMutations":[{"path":["tax_display_default"],"value":"inclusive"},{"path":["remembered_preferences","sales.default_metric"],"value":"commerce.gross_takings_inc_gst"}]}],"question":"When you say sales, which figure should Albert use by default?"},{"connectorPrerequisites":["lightspeed-r"],"id":"trading-day","label":"Trading-day cutoff","options":[{"id":"midnight","label":"Midnight","overlayMutations":[{"path":["trading_day_cutoff"],"value":"00:00"}]},{"id":"2am","label":"2 am","overlayMutations":[{"path":["trading_day_cutoff"],"value":"02:00"}]},{"id":"4am","label":"4 am","overlayMutations":[{"path":["trading_day_cutoff"],"value":"04:00"}]}],"question":"When should a trading day end for overnight activity?"},{"connectorPrerequisites":["lightspeed-r","deputy"],"id":"employee-performance","label":"Employee performance","options":[{"id":"net-sales","label":"Net sales","overlayMutations":[{"path":["remembered_preferences","employee.performance_default"],"value":"commerce.net_sales_ex_gst"}]},{"id":"gross-profit","label":"Gross profit","overlayMutations":[{"path":["remembered_preferences","employee.performance_default"],"value":"commerce.gross_margin"}]},{"id":"profit-per-hour","label":"Gross profit per worked hour","overlayMutations":[{"path":["remembered_preferences","employee.performance_default"],"value":"composites.gross_profit_per_labour_hour"}]}],"question":"What should performed best mean by default?"},{"connectorPrerequisites":["lightspeed-r","xero"],"id":"pos-posting-topology","label":"Xero posting method","options":[{"id":"daily-summary","label":"Daily summary journals","overlayMutations":[{"path":["remembered_preferences","reconciliation.pos_posting_topology"],"value":"daily_summary_journals"}]},{"id":"line-by-line","label":"Individual transactions","overlayMutations":[{"path":["remembered_preferences","reconciliation.pos_posting_topology"],"value":"individual_transactions"}]},{"id":"not-sure","label":"I’m not sure","overlayMutations":[{"path":["remembered_preferences","reconciliation.pos_posting_topology"],"value":"unknown"}]}],"question":"How does your point of sale normally post takings into Xero?"}],"schemaVersion":1}$blocking_questions$
);

CREATE OR REPLACE FUNCTION control_plane.reject_blocking_question_contract_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'blocking question contract is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER blocking_question_contract_reject_row_mutation
  BEFORE UPDATE OR DELETE ON control_plane.blocking_question_contract
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_blocking_question_contract_mutation();

CREATE TRIGGER blocking_question_contract_reject_truncate
  BEFORE TRUNCATE ON control_plane.blocking_question_contract
  FOR EACH STATEMENT EXECUTE FUNCTION control_plane.reject_blocking_question_contract_mutation();

ALTER TABLE control_plane.blocking_question_contract ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE control_plane.blocking_question_contract
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.reject_blocking_question_contract_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.albert_answer_blocking_question(
  p_question_id text,
  p_option_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  request_role text := extensions.albert_auth_jwt() ->> 'role';
  selected_tenant text := control_plane.require_current_tenant_id();
  selected_question jsonb;
  selected_option jsonb;
  selected_contract_version text;
  selected_contract_digest text;
  current_overlay control_plane.tenant_overlays%ROWTYPE;
  previous_response text;
  previous_option text;
  next_response_version integer;
  next_overlay jsonb;
  overlay_mutation jsonb;
  overlay_path text[];
BEGIN
  IF request_role IS DISTINCT FROM 'authenticated'
    OR actor IS NULL
    OR NOT control_plane.has_tenant_role(
    selected_tenant,
    ARRAY['owner', 'manager']::text[]
  ) THEN
    RAISE EXCEPTION 'authenticated owner or manager role required'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    question_row.question_item,
    option_row.option_item,
    contract.contract_version,
    contract.contract_digest
  INTO
    selected_question,
    selected_option,
    selected_contract_version,
    selected_contract_digest
  FROM control_plane.blocking_question_contract AS contract
  CROSS JOIN LATERAL jsonb_array_elements(
    contract.contract_canonical_json::jsonb -> 'questions'
  ) AS question_row(question_item)
  CROSS JOIN LATERAL jsonb_array_elements(
    question_row.question_item -> 'options'
  ) AS option_row(option_item)
  WHERE contract.singleton
    AND question_row.question_item ->> 'id' = p_question_id
    AND option_row.option_item ->> 'id' = p_option_id;

  IF selected_option IS NULL THEN
    RAISE EXCEPTION 'blocking question option is not allowlisted'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      selected_question -> 'connectorPrerequisites'
    ) AS prerequisite(connector_key)
    WHERE NOT EXISTS (
      SELECT 1
      FROM control_plane.connections AS connection
      WHERE connection.tenant_id = selected_tenant
        AND connection.connector_key = prerequisite.connector_key
        AND connection.status NOT IN ('pending', 'disconnected')
    )
  ) THEN
    RAISE EXCEPTION 'blocking question connector prerequisites are not satisfied'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO current_overlay
  FROM control_plane.tenant_overlays AS overlay
  WHERE overlay.tenant_id = selected_tenant
    AND overlay.status = 'published'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'published tenant overlay is missing' USING ERRCODE = 'P0002';
  END IF;

  SELECT
    response.response_id,
    response.option_id,
    response.response_version + 1
  INTO previous_response, previous_option, next_response_version
  FROM control_plane.onboarding_question_responses AS response
  WHERE response.tenant_id = selected_tenant
    AND response.question_id = p_question_id
  ORDER BY response.response_version DESC
  LIMIT 1;
  IF previous_option = p_option_id THEN
    RETURN;
  END IF;
  next_response_version := coalesce(next_response_version, 1);

  INSERT INTO control_plane.onboarding_question_responses (
    tenant_id,
    response_id,
    question_id,
    option_id,
    response_version,
    previous_response_id,
    answered_by
  ) VALUES (
    selected_tenant,
    control_plane.generate_ulid(),
    p_question_id,
    p_option_id,
    next_response_version,
    previous_response,
    actor
  );

  next_overlay := current_overlay.overlay || jsonb_build_object(
    'blocking_answers',
    coalesce(current_overlay.overlay -> 'blocking_answers', '{}'::jsonb),
    'remembered_preferences',
    coalesce(current_overlay.overlay -> 'remembered_preferences', '{}'::jsonb)
  );
  next_overlay := jsonb_set(
    next_overlay,
    ARRAY['blocking_answers', p_question_id],
    to_jsonb(p_option_id),
    true
  );

  FOR overlay_mutation IN
    SELECT mutation_row.mutation_item
    FROM jsonb_array_elements(
      selected_option -> 'overlayMutations'
    ) AS mutation_row(mutation_item)
  LOOP
    SELECT array_agg(path_row.path_item ORDER BY path_row.ordinal)
    INTO overlay_path
    FROM jsonb_array_elements_text(
      overlay_mutation -> 'path'
    ) WITH ORDINALITY AS path_row(path_item, ordinal);

    IF overlay_path IS NULL OR jsonb_typeof(overlay_mutation -> 'value') IN ('array', 'object') THEN
      RAISE EXCEPTION 'installed blocking question contract is invalid'
        USING ERRCODE = '55000';
    END IF;
    next_overlay := jsonb_set(
      next_overlay,
      overlay_path,
      overlay_mutation -> 'value',
      true
    );
  END LOOP;

  UPDATE control_plane.tenant_overlays
  SET status = 'superseded', superseded_at = now()
  WHERE tenant_id = selected_tenant
    AND overlay_id = current_overlay.overlay_id;
  INSERT INTO control_plane.tenant_overlays (
    tenant_id,
    overlay_id,
    version,
    status,
    overlay,
    change_reason,
    created_by,
    published_at
  ) VALUES (
    selected_tenant,
    control_plane.generate_ulid(),
    current_overlay.version + 1,
    'published',
    next_overlay,
    'Blocking question answered: ' || p_question_id,
    actor,
    now()
  );
  INSERT INTO control_plane.audit_log (
    tenant_id,
    audit_id,
    actor_user_id,
    actor_type,
    action,
    resource_type,
    resource_id,
    audit_metadata
  ) VALUES (
    selected_tenant,
    control_plane.generate_ulid(),
    actor,
    'user',
    'onboarding.blocking_question_answered',
    'onboarding_question',
    p_question_id,
    jsonb_build_object(
      'option_id', p_option_id,
      'response_version', next_response_version,
      'overlay_version', current_overlay.version + 1,
      'contract_version', selected_contract_version,
      'contract_digest', selected_contract_digest
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.albert_answer_blocking_question(text, text)
  FROM PUBLIC,
       anon,
       service_role,
       albert_sync_control,
       albert_webhook_control,
       albert_transform_control,
       albert_semantic_control,
       albert_operator_diagnostic_control,
       albert_deletion_control;
GRANT EXECUTE ON FUNCTION public.albert_answer_blocking_question(text, text)
  TO authenticated;

COMMIT;
