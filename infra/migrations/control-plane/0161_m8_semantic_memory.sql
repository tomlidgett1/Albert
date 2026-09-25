-- 0161: per-tenant semantic memory — deterministic learned vocabulary rules
-- (ADR 0115).
--
-- A rule binds a phrase the owner uses ("general service") to what it means in
-- the governed catalogue (the item "Service - General Service", not the
-- "Services" category), or records a stated preference. Rules are captured by
-- the Codex runtime's remember_term tool when the owner corrects an
-- interpretation or asks Albert to remember one, matched against later
-- questions, and reviewable/retirable by the owner in Settings ("Albert's
-- memory"). Rules carry vocabulary only, never figures.
--
-- Access posture: every active member of the tenant reads and writes — the
-- rules are captured from any member's conversations — through
-- SECURITY DEFINER RPCs (same shape as tenant_business_context, 0153).
-- Hard delete stays owner/manager; everyone else retires.

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.tenant_semantic_memory (
  tenant_id text NOT NULL,
  rule_id text NOT NULL DEFAULT control_plane.generate_ulid(),
  kind text NOT NULL DEFAULT 'term_binding' CHECK (kind IN ('term_binding', 'preference')),
  term text NOT NULL CHECK (length(btrim(term)) BETWEEN 2 AND 80),
  normalized_term text NOT NULL CHECK (length(normalized_term) BETWEEN 1 AND 120),
  meaning text NOT NULL CHECK (length(btrim(meaning)) BETWEEN 3 AND 300),
  counter_meaning text CHECK (counter_meaning IS NULL OR length(btrim(counter_meaning)) BETWEEN 3 AND 300),
  binding jsonb CHECK (binding IS NULL OR (jsonb_typeof(binding) = 'object' AND binding ? 'view')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'retired')),
  source text NOT NULL DEFAULT 'albert' CHECK (source IN ('albert', 'owner')),
  source_conversation_id text,
  source_turn_id text,
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (tenant_id, rule_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_semantic_memory_term
  ON control_plane.tenant_semantic_memory (tenant_id, kind, normalized_term);
ALTER TABLE control_plane.tenant_semantic_memory ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.normalize_semantic_term(p_term text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT btrim(regexp_replace(lower(coalesce(p_term, '')), '[^a-z0-9]+', ' ', 'g'));
$$;

CREATE OR REPLACE FUNCTION control_plane.semantic_memory_rule_json(rule control_plane.tenant_semantic_memory)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'ruleId', rule.rule_id,
    'kind', rule.kind,
    'term', rule.term,
    'meaning', rule.meaning,
    'counterMeaning', rule.counter_meaning,
    'binding', rule.binding,
    'status', rule.status,
    'source', rule.source,
    'sourceConversationId', rule.source_conversation_id,
    'useCount', rule.use_count,
    'lastUsedAt', rule.last_used_at,
    'createdAt', rule.created_at,
    'updatedAt', rule.updated_at
  );
$$;

-- Read: any active member. Every rule including retired ones, newest first —
-- the Settings view is the audit surface, so nothing is hidden.
CREATE OR REPLACE FUNCTION public.albert_semantic_memory()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT coalesce(jsonb_agg(control_plane.semantic_memory_rule_json(rule) ORDER BY rule.updated_at DESC), '[]'::jsonb)
  FROM control_plane.tenant_semantic_memory AS rule
  WHERE rule.tenant_id = control_plane.require_current_tenant_id();
$$;

-- Upsert one rule by (kind, normalised term). A re-taught term updates the
-- existing rule; a retired rule is revived; a confirmed rule is never silently
-- downgraded to proposed by an automatic capture.
CREATE OR REPLACE FUNCTION public.albert_save_semantic_rule(
  p_kind text,
  p_term text,
  p_meaning text,
  p_counter_meaning text DEFAULT NULL,
  p_binding jsonb DEFAULT NULL,
  p_status text DEFAULT 'proposed',
  p_source text DEFAULT 'albert',
  p_conversation_id text DEFAULT NULL,
  p_turn_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_actor uuid := extensions.albert_auth_uid();
  v_normalized text := control_plane.normalize_semantic_term(p_term);
  v_count integer;
  v_row control_plane.tenant_semantic_memory%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_kind NOT IN ('term_binding', 'preference') THEN
    RAISE EXCEPTION 'semantic rule kind must be term_binding or preference' USING ERRCODE = '22023';
  END IF;
  IF p_status NOT IN ('proposed', 'confirmed') THEN
    RAISE EXCEPTION 'semantic rule status must be proposed or confirmed' USING ERRCODE = '22023';
  END IF;
  IF p_source NOT IN ('albert', 'owner') THEN
    RAISE EXCEPTION 'semantic rule source must be albert or owner' USING ERRCODE = '22023';
  END IF;
  IF v_normalized = '' THEN
    RAISE EXCEPTION 'semantic rule term must contain at least one word' USING ERRCODE = '22023';
  END IF;
  IF p_binding IS NOT NULL AND (jsonb_typeof(p_binding) <> 'object' OR NOT p_binding ? 'view') THEN
    RAISE EXCEPTION 'semantic rule binding must be an object naming a view' USING ERRCODE = '22023';
  END IF;

  SELECT admin.tenant_id INTO v_tenant_id
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_count
    FROM control_plane.tenant_semantic_memory
    WHERE tenant_id = v_tenant_id;
  IF v_count >= 200 AND NOT EXISTS (
    SELECT 1 FROM control_plane.tenant_semantic_memory
    WHERE tenant_id = v_tenant_id AND kind = p_kind AND normalized_term = v_normalized
  ) THEN
    RAISE EXCEPTION 'this organisation already holds 200 learned rules; retire one first' USING ERRCODE = '54000';
  END IF;

  INSERT INTO control_plane.tenant_semantic_memory (
    tenant_id, kind, term, normalized_term, meaning, counter_meaning, binding,
    status, source, source_conversation_id, source_turn_id,
    created_by, updated_by
  ) VALUES (
    v_tenant_id, p_kind, btrim(p_term), v_normalized, btrim(p_meaning), nullif(btrim(coalesce(p_counter_meaning, '')), ''), p_binding,
    p_status, p_source, p_conversation_id, p_turn_id,
    v_actor, v_actor
  )
  ON CONFLICT (tenant_id, kind, normalized_term) DO UPDATE SET
    term = EXCLUDED.term,
    meaning = EXCLUDED.meaning,
    counter_meaning = EXCLUDED.counter_meaning,
    binding = coalesce(EXCLUDED.binding, control_plane.tenant_semantic_memory.binding),
    status = CASE
      WHEN control_plane.tenant_semantic_memory.status = 'confirmed' AND EXCLUDED.status = 'proposed' THEN 'confirmed'
      ELSE EXCLUDED.status
    END,
    source = EXCLUDED.source,
    source_conversation_id = coalesce(EXCLUDED.source_conversation_id, control_plane.tenant_semantic_memory.source_conversation_id),
    source_turn_id = coalesce(EXCLUDED.source_turn_id, control_plane.tenant_semantic_memory.source_turn_id),
    updated_at = v_now,
    updated_by = v_actor
  RETURNING * INTO v_row;

  RETURN control_plane.semantic_memory_rule_json(v_row);
END;
$$;

-- Confirm, retire or restore one rule. Any active member; visible to all.
CREATE OR REPLACE FUNCTION public.albert_update_semantic_rule_status(
  p_rule_id text,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_actor uuid := extensions.albert_auth_uid();
  v_row control_plane.tenant_semantic_memory%ROWTYPE;
BEGIN
  IF p_status NOT IN ('proposed', 'confirmed', 'retired') THEN
    RAISE EXCEPTION 'semantic rule status must be proposed, confirmed or retired' USING ERRCODE = '22023';
  END IF;
  SELECT admin.tenant_id INTO v_tenant_id
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  UPDATE control_plane.tenant_semantic_memory SET
    status = p_status,
    updated_at = clock_timestamp(),
    updated_by = v_actor
  WHERE tenant_id = v_tenant_id AND rule_id = p_rule_id
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such learned rule' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.semantic_memory_rule_json(v_row);
END;
$$;

-- Hard delete: owner/manager only. Retiring is the everyday path.
CREATE OR REPLACE FUNCTION public.albert_delete_semantic_rule(p_rule_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
BEGIN
  SELECT admin.tenant_id, admin.role INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'insufficient role for deleting learned rules' USING ERRCODE = '42501';
  END IF;
  DELETE FROM control_plane.tenant_semantic_memory
  WHERE tenant_id = v_tenant_id AND rule_id = p_rule_id;
  RETURN FOUND;
END;
$$;

-- Usage bookkeeping when rules are injected into a turn. Best-effort.
CREATE OR REPLACE FUNCTION public.albert_record_semantic_rule_use(p_rule_ids text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_updated integer;
BEGIN
  SELECT admin.tenant_id INTO v_tenant_id
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'no active organisation' USING ERRCODE = '42501';
  END IF;
  UPDATE control_plane.tenant_semantic_memory SET
    use_count = use_count + 1,
    last_used_at = clock_timestamp()
  WHERE tenant_id = v_tenant_id AND rule_id = ANY(coalesce(p_rule_ids, ARRAY[]::text[]));
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.normalize_semantic_term(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.semantic_memory_rule_json(control_plane.tenant_semantic_memory) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_semantic_memory() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_save_semantic_rule(text, text, text, text, jsonb, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_update_semantic_rule_status(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_delete_semantic_rule(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_record_semantic_rule_use(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_semantic_memory() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_save_semantic_rule(text, text, text, text, jsonb, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_update_semantic_rule_status(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_delete_semantic_rule(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_record_semantic_rule_use(text[]) TO authenticated;

COMMIT;
