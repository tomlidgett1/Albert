-- 0182: Discover prompts (ADR 0130).
--
-- Per-tenant cache of the thirty "questions worth asking" cards the Discover
-- surface shows, personalised by a model over the connected tools and the
-- business context. Cards are copy over library seeds, never governed
-- numbers, so any active member of the tenant may read or refresh them.

BEGIN;

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('conversation.discover_prompts', 8, 3600, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess,
  enabled = true;

CREATE TABLE IF NOT EXISTS control_plane.discover_prompts (
  tenant_id text PRIMARY KEY,
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  cards jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  generated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(cards) = 'array'),
  CHECK (jsonb_array_length(cards) <= 40),
  CHECK (length(cards::text) <= 40000)
);
ALTER TABLE control_plane.discover_prompts ENABLE ROW LEVEL SECURITY;

-- Read: any active member of the selected tenant. NULL when nothing is cached.
CREATE OR REPLACE FUNCTION public.albert_discover_prompts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'sourceFingerprint', cached.source_fingerprint,
    'cards', cached.cards,
    'model', cached.model,
    'generatedAt', cached.generated_at
  )
  FROM control_plane.discover_prompts AS cached
  WHERE cached.tenant_id = control_plane.require_current_tenant_id();
$$;

-- Write: any active member. Last writer wins; the fingerprint keeps stale
-- generations from being served once tools or context change.
CREATE OR REPLACE FUNCTION public.albert_save_discover_prompts(
  p_source_fingerprint text,
  p_cards jsonb,
  p_model text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  saved control_plane.discover_prompts%ROWTYPE;
BEGIN
  IF p_source_fingerprint IS NULL OR p_source_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'discover fingerprint is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_cards IS NULL OR jsonb_typeof(p_cards) <> 'array' THEN
    RAISE EXCEPTION 'discover cards must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_cards) > 40 THEN
    RAISE EXCEPTION 'discover holds at most 40 cards' USING ERRCODE = '22023';
  END IF;
  IF length(p_cards::text) > 40000 THEN
    RAISE EXCEPTION 'discover cards are too large' USING ERRCODE = '22023';
  END IF;
  IF p_model IS NULL OR length(btrim(p_model)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'discover model is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.discover_prompts (
    tenant_id, source_fingerprint, cards, model, generated_at
  ) VALUES (
    selected_tenant, p_source_fingerprint, p_cards, btrim(p_model), clock_timestamp()
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    source_fingerprint = EXCLUDED.source_fingerprint,
    cards = EXCLUDED.cards,
    model = EXCLUDED.model,
    generated_at = EXCLUDED.generated_at
  RETURNING * INTO saved;

  RETURN jsonb_build_object(
    'sourceFingerprint', saved.source_fingerprint,
    'cards', saved.cards,
    'model', saved.model,
    'generatedAt', saved.generated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.albert_discover_prompts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_save_discover_prompts(text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_discover_prompts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_save_discover_prompts(text, jsonb, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
