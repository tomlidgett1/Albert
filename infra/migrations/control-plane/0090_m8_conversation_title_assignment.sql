BEGIN;

-- Lightweight conversation titles: assign once from the first user question.
-- Generation runs in the conversation service (gpt-5-nano); this RPC only
-- persists the first non-empty title for the authenticated owner.

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('conversation.title', 40, 60, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess;

CREATE OR REPLACE FUNCTION public.albert_conversation_needs_title(
  p_conversation_id text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  current_title text;
BEGIN
  IF actor IS NULL
     OR p_conversation_id IS NULL
     OR NOT control_plane.is_ulid(p_conversation_id) THEN
    RAISE EXCEPTION 'conversation id is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT conversation.title
    INTO current_title
    FROM control_plane.conversations AS conversation
   WHERE conversation.tenant_id = selected_tenant
     AND conversation.conversation_id = p_conversation_id
     AND conversation.created_by = actor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation was not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN current_title IS NULL OR btrim(current_title) = '';
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_assign_conversation_title(
  p_conversation_id text,
  p_title text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  current_title text;
  next_title text := nullif(btrim(p_title), '');
BEGIN
  IF actor IS NULL
     OR p_conversation_id IS NULL
     OR NOT control_plane.is_ulid(p_conversation_id)
     OR next_title IS NULL
     OR length(next_title) > 120 THEN
    RAISE EXCEPTION 'conversation title is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT conversation.title
    INTO current_title
    FROM control_plane.conversations AS conversation
   WHERE conversation.tenant_id = selected_tenant
     AND conversation.conversation_id = p_conversation_id
     AND conversation.created_by = actor
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation was not found' USING ERRCODE = 'P0002';
  END IF;

  IF current_title IS NOT NULL AND btrim(current_title) <> '' THEN
    RETURN jsonb_build_object(
      'title', btrim(current_title),
      'assigned', false
    );
  END IF;

  UPDATE control_plane.conversations AS conversation
     SET title = next_title,
         updated_at = conversation.updated_at
   WHERE conversation.tenant_id = selected_tenant
     AND conversation.conversation_id = p_conversation_id
     AND conversation.created_by = actor
     AND (conversation.title IS NULL OR btrim(conversation.title) = '');

  RETURN jsonb_build_object(
    'title', next_title,
    'assigned', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.albert_conversation_needs_title(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_assign_conversation_title(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_conversation_needs_title(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_assign_conversation_title(text, text) TO authenticated;

COMMIT;
