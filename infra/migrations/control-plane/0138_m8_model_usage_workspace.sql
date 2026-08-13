-- Owner-visible per-query usage: list the append-only cost ledger, and let
-- the authenticated web runtime record v3 turns that never pass through the
-- signed semantic finalizer. Raw provider payloads stay off this surface.

BEGIN;

CREATE INDEX IF NOT EXISTS model_usage_ledger_actor_recorded_idx
  ON control_plane.model_usage_ledger (tenant_id, recorded_by, recorded_at DESC);

CREATE OR REPLACE FUNCTION public.albert_list_model_usage(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  result jsonb;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'model usage request is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'usage limit must be between 1 and 200' USING ERRCODE = '22023';
  END IF;

  WITH filtered AS (
    SELECT
      ledger.usage_ledger_id,
      ledger.conversation_id,
      ledger.turn_id,
      ledger.recorded_at,
      ledger.model,
      ledger.fast_mode,
      ledger.requests,
      ledger.input_tokens,
      ledger.output_tokens,
      ledger.cached_input_tokens,
      ledger.estimated_cost_usd_micros,
      turn.user_message,
      conversation.title
    FROM control_plane.model_usage_ledger AS ledger
    JOIN control_plane.conversation_turns AS turn
      ON turn.tenant_id = ledger.tenant_id
     AND turn.turn_id = ledger.turn_id
    JOIN control_plane.conversations AS conversation
      ON conversation.tenant_id = ledger.tenant_id
     AND conversation.conversation_id = ledger.conversation_id
    WHERE ledger.tenant_id = selected_tenant
      AND turn.created_by = actor
      AND conversation.created_by = actor
      AND turn.hidden_at IS NULL
  )
  SELECT jsonb_build_object(
    'entries', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'usageLedgerId', listed.usage_ledger_id,
        'conversationId', listed.conversation_id,
        'turnId', listed.turn_id,
        'recordedAt', listed.recorded_at,
        'model', listed.model,
        'fastMode', listed.fast_mode,
        'requests', listed.requests,
        'inputTokens', listed.input_tokens,
        'outputTokens', listed.output_tokens,
        'cachedInputTokens', listed.cached_input_tokens,
        'estimatedCostUsdMicros', listed.estimated_cost_usd_micros,
        'query', left(btrim(listed.user_message), 160),
        'conversationTitle', listed.title
      ) ORDER BY listed.recorded_at DESC)
      FROM (
        SELECT *
        FROM filtered
        ORDER BY recorded_at DESC
        LIMIT p_limit
      ) AS listed
    ), '[]'::jsonb),
    'totals', (
      SELECT jsonb_build_object(
        'queries', count(*)::integer,
        'inputTokens', coalesce(sum(input_tokens), 0)::bigint,
        'outputTokens', coalesce(sum(output_tokens), 0)::bigint,
        'estimatedCostUsdMicros', coalesce(sum(estimated_cost_usd_micros), 0)::bigint
      )
      FROM filtered
    )
  )
  INTO result;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_record_turn_usage(
  p_conversation_id text,
  p_turn_id text,
  p_metering jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  turn control_plane.conversation_turns%ROWTYPE;
  digest text;
  existing_digest text;
BEGIN
  IF actor IS NULL
     OR NOT control_plane.is_ulid(p_conversation_id)
     OR NOT control_plane.is_ulid(p_turn_id)
     OR p_metering IS NULL
     OR jsonb_typeof(p_metering) <> 'object' THEN
    RAISE EXCEPTION 'model usage input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO turn
  FROM control_plane.conversation_turns AS candidate
  JOIN control_plane.conversations AS conversation
    ON conversation.tenant_id = candidate.tenant_id
   AND conversation.conversation_id = candidate.conversation_id
  WHERE candidate.tenant_id = selected_tenant
    AND candidate.turn_id = p_turn_id
    AND candidate.conversation_id = p_conversation_id
    AND candidate.created_by = actor
    AND conversation.created_by = actor
  FOR UPDATE OF candidate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation turn was not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_metering ->> 'model' IS DISTINCT FROM turn.runtime_profile ->> 'model'
     OR (p_metering ->> 'fastMode')::boolean IS DISTINCT FROM
        coalesce((turn.runtime_profile ->> 'fastMode')::boolean, false)
     OR p_metering ->> 'model' NOT IN (
       'gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','grok-4.6',
       'claude-opus-5','claude-sonnet-5'
     )
     OR p_metering ->> 'pricingCompleteness' NOT IN ('request_level', 'aggregate_estimate')
     OR coalesce(p_metering ->> 'rateCardId', '') !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
     OR coalesce(p_metering ->> 'requests', '') !~ '^[0-9]+$'
     OR (p_metering ->> 'requests')::bigint < 1
     OR coalesce(p_metering ->> 'inputTokens', '') !~ '^[0-9]+$'
     OR coalesce(p_metering ->> 'cachedInputTokens', '') !~ '^[0-9]+$'
     OR coalesce(p_metering ->> 'cacheWriteInputTokens', '') !~ '^[0-9]+$'
     OR coalesce(p_metering ->> 'outputTokens', '') !~ '^[0-9]+$'
     OR coalesce(p_metering ->> 'estimatedCostUsdMicros', '') !~ '^[0-9]+$'
     OR (p_metering ->> 'cachedInputTokens')::bigint
        + (p_metering ->> 'cacheWriteInputTokens')::bigint
        > (p_metering ->> 'inputTokens')::bigint THEN
    RAISE EXCEPTION 'metering does not match the turn' USING ERRCODE = '22023';
  END IF;

  digest := encode(extensions.digest(convert_to(p_metering::text, 'UTF8'), 'sha256'), 'hex');
  SELECT ledger.metering_digest INTO existing_digest
  FROM control_plane.model_usage_ledger AS ledger
  WHERE ledger.tenant_id = selected_tenant AND ledger.turn_id = p_turn_id;
  IF existing_digest IS NOT NULL THEN
    IF existing_digest <> digest THEN
      RAISE EXCEPTION 'turn usage was already recorded differently' USING ERRCODE = '23505';
    END IF;
    RETURN digest;
  END IF;

  INSERT INTO control_plane.model_usage_ledger (
    tenant_id, usage_ledger_id, conversation_id, turn_id, rate_card_id,
    model, fast_mode, requests, input_tokens, cached_input_tokens,
    cache_write_input_tokens, output_tokens, estimated_cost_usd_micros,
    pricing_completeness, metering_digest, recorded_by
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), p_conversation_id, p_turn_id,
    p_metering ->> 'rateCardId', p_metering ->> 'model',
    (p_metering ->> 'fastMode')::boolean,
    (p_metering ->> 'requests')::integer,
    (p_metering ->> 'inputTokens')::bigint,
    (p_metering ->> 'cachedInputTokens')::bigint,
    (p_metering ->> 'cacheWriteInputTokens')::bigint,
    (p_metering ->> 'outputTokens')::bigint,
    (p_metering ->> 'estimatedCostUsdMicros')::bigint,
    p_metering ->> 'pricingCompleteness', digest, actor
  );

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'model.usage_recorded', 'conversation_turn', p_turn_id,
    jsonb_build_object('metering_digest', digest, 'rate_card_id', p_metering ->> 'rateCardId')
  );

  RETURN digest;
END;
$$;

COMMENT ON FUNCTION public.albert_list_model_usage(integer) IS
  'Tenant-scoped, actor-owned per-turn token and estimated API cost list. Newest first. Does not expose raw provider payloads.';

COMMENT ON FUNCTION public.albert_record_turn_usage(text, text, jsonb) IS
  'Digest-idempotent per-turn cost ledger write for the authenticated web runtime. Provider invoices remain the reconciliation authority.';

REVOKE ALL ON FUNCTION public.albert_list_model_usage(integer) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.albert_record_turn_usage(text, text, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.albert_list_model_usage(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_record_turn_usage(text, text, jsonb) TO authenticated;

COMMIT;
