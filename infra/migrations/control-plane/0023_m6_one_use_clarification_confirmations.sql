BEGIN;

-- Models may choose only an opaque option id. The key/value/label bound to an
-- option is owned here and cannot be supplied or altered by the browser.
CREATE TABLE IF NOT EXISTS control_plane.preference_value_allowlist (
  option_id text PRIMARY KEY CHECK (option_id ~ '^[a-z][a-z0-9_.]{2,79}$'),
  preference_key text NOT NULL CHECK (preference_key ~ '^[a-z][a-z0-9_.]{2,119}$'),
  preference_value text NOT NULL CHECK (length(preference_value) BETWEEN 1 AND 300),
  option_label text NOT NULL CHECK (length(btrim(option_label)) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (preference_key,preference_value),
  UNIQUE (option_id,preference_key,preference_value)
);

INSERT INTO control_plane.preference_value_allowlist(
  option_id,preference_key,preference_value,option_label
) VALUES
  ('sales.net_ex_gst','sales.default_metric','commerce.net_sales_ex_gst','Net sales (ex GST)'),
  ('sales.gross_inc_gst','sales.default_metric','commerce.gross_takings_inc_gst','Gross takings (inc GST)'),
  ('employee.net_sales','employee.performance_default','commerce.net_sales_ex_gst','Net sales'),
  ('employee.gross_margin','employee.performance_default','commerce.gross_margin','Gross margin'),
  ('employee.sales_per_labour_hour','employee.performance_default','composites.sales_per_labour_hour','Sales per worked hour'),
  ('reconciliation.daily_summary','reconciliation.pos_posting_topology','daily_summary_journals','Daily summary journals'),
  ('reconciliation.individual_transactions','reconciliation.pos_posting_topology','individual_transactions','Individual transactions'),
  ('reconciliation.unknown','reconciliation.pos_posting_topology','unknown','I’m not sure'),
  ('finance.operational_gross_margin','finance.profit_default','commerce.gross_margin','Operational gross margin'),
  ('finance.accounting_gross_profit','finance.profit_default','finance.gross_profit_accounting','Accounting gross profit'),
  ('finance.accounting_net_profit','finance.profit_default','finance.net_profit','Accounting net profit')
ON CONFLICT (option_id) DO UPDATE SET
  preference_key=EXCLUDED.preference_key,
  preference_value=EXCLUDED.preference_value,
  option_label=EXCLUDED.option_label,
  active=true;

CREATE OR REPLACE FUNCTION control_plane.enforce_preference_value_allowlist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  preferences jsonb:=coalesce(NEW.overlay->'remembered_preferences','{}'::jsonb);
  invalid_key text;
BEGIN
  IF jsonb_typeof(preferences)<>'object' THEN
    RAISE EXCEPTION 'remembered preferences must be an object' USING ERRCODE='22023';
  END IF;
  SELECT entry.key INTO invalid_key
    FROM jsonb_each(preferences) AS entry(key,value)
   WHERE jsonb_typeof(entry.value)<>'string'
      OR NOT EXISTS (
        SELECT 1
          FROM control_plane.preference_value_allowlist AS allowed
         WHERE allowed.preference_key=entry.key
           AND allowed.preference_value=entry.value#>>'{}'
           AND allowed.active
      )
   ORDER BY entry.key
   LIMIT 1;
  IF invalid_key IS NOT NULL THEN
    RAISE EXCEPTION 'tenant preference is not allowlisted: %',invalid_key USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE invalid_count integer;
BEGIN
  SELECT count(*) INTO invalid_count
    FROM control_plane.tenant_overlays AS overlay
    CROSS JOIN LATERAL jsonb_each(
      coalesce(overlay.overlay->'remembered_preferences','{}'::jsonb)
    ) AS entry(key,value)
   WHERE jsonb_typeof(entry.value)<>'string'
      OR NOT EXISTS (
        SELECT 1
          FROM control_plane.preference_value_allowlist AS allowed
         WHERE allowed.preference_key=entry.key
           AND allowed.preference_value=entry.value#>>'{}'
           AND allowed.active
      );
  IF invalid_count<>0 THEN
    RAISE EXCEPTION 'existing tenant overlays contain non-allowlisted preferences';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS tenant_overlays_preference_allowlist
  ON control_plane.tenant_overlays;
CREATE TRIGGER tenant_overlays_preference_allowlist
  BEFORE INSERT OR UPDATE OF overlay ON control_plane.tenant_overlays
  FOR EACH ROW EXECUTE FUNCTION control_plane.enforce_preference_value_allowlist();

CREATE TABLE IF NOT EXISTS control_plane.clarification_prompts (
  tenant_id text NOT NULL,
  conversation_id text NOT NULL,
  offered_turn_id text NOT NULL,
  source_turn_event_id text NOT NULL,
  question text NOT NULL CHECK (length(btrim(question)) BETWEEN 1 AND 300),
  offered_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  offered_at timestamptz NOT NULL DEFAULT now(),
  consumed_turn_id text,
  consumed_option_id text,
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id,offered_turn_id),
  UNIQUE (tenant_id,source_turn_event_id),
  FOREIGN KEY (tenant_id,offered_turn_id)
    REFERENCES control_plane.conversation_turns(tenant_id,turn_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,conversation_id)
    REFERENCES control_plane.conversations(tenant_id,conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,consumed_turn_id)
    REFERENCES control_plane.conversation_turns(tenant_id,turn_id) ON DELETE RESTRICT,
  CHECK ((consumed_turn_id IS NULL AND consumed_option_id IS NULL AND consumed_at IS NULL)
      OR (consumed_turn_id IS NOT NULL AND consumed_option_id IS NOT NULL AND consumed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS control_plane.clarification_options (
  tenant_id text NOT NULL,
  conversation_id text NOT NULL,
  offered_turn_id text NOT NULL,
  option_id text NOT NULL,
  preference_key text NOT NULL,
  preference_value text NOT NULL,
  option_label text NOT NULL,
  PRIMARY KEY (tenant_id,offered_turn_id,option_id),
  FOREIGN KEY (tenant_id,offered_turn_id)
    REFERENCES control_plane.clarification_prompts(tenant_id,offered_turn_id) ON DELETE CASCADE,
  FOREIGN KEY (option_id,preference_key,preference_value)
    REFERENCES control_plane.preference_value_allowlist(option_id,preference_key,preference_value)
);

CREATE UNIQUE INDEX IF NOT EXISTS clarification_prompts_one_per_consuming_turn
  ON control_plane.clarification_prompts(tenant_id,consumed_turn_id)
  WHERE consumed_turn_id IS NOT NULL;

ALTER TABLE control_plane.preference_value_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.clarification_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.clarification_options ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.capture_clarification_options()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  offered_by_user uuid;
  option_count integer;
  matched_count integer;
  distinct_option_count integer;
  distinct_preference_count integer;
BEGIN
  IF NEW.event->>'type'<>'clarification' THEN
    RETURN NEW;
  END IF;
  IF NEW.event->>'status'<>'complete'
     OR length(btrim(coalesce(NEW.event->>'question',''))) NOT BETWEEN 1 AND 300
     OR jsonb_typeof(NEW.event->'options')<>'array'
     OR jsonb_array_length(NEW.event->'options') NOT BETWEEN 2 AND 3 THEN
    RAISE EXCEPTION 'clarification event is invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.event->'options') AS item(option)
     WHERE jsonb_typeof(item.option)<>'object'
        OR jsonb_typeof(item.option->'id')<>'string'
        OR jsonb_typeof(item.option->'label')<>'string'
        OR item.option-'id'-'label'<>'{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'clarification options must contain only id and label' USING ERRCODE='22023';
  END IF;

  SELECT count(*),count(DISTINCT item.option->>'id'),count(allowed.option_id),
         count(DISTINCT allowed.preference_key)
    INTO option_count,distinct_option_count,matched_count,distinct_preference_count
    FROM jsonb_array_elements(NEW.event->'options') AS item(option)
    LEFT JOIN control_plane.preference_value_allowlist AS allowed
      ON allowed.option_id=item.option->>'id'
     AND allowed.option_label=item.option->>'label'
     AND allowed.active;
  IF matched_count<>option_count
     OR distinct_option_count<>option_count
     OR distinct_preference_count<>1 THEN
    RAISE EXCEPTION 'clarification options are not one canonical preference group' USING ERRCODE='22023';
  END IF;

  SELECT turn.created_by INTO offered_by_user
    FROM control_plane.conversation_turns AS turn
   WHERE turn.tenant_id=NEW.tenant_id
     AND turn.turn_id=NEW.turn_id
     AND turn.conversation_id=NEW.conversation_id;
  IF offered_by_user IS NULL THEN
    RAISE EXCEPTION 'clarification owner was not found' USING ERRCODE='P0002';
  END IF;

  INSERT INTO control_plane.clarification_prompts(
    tenant_id,conversation_id,offered_turn_id,source_turn_event_id,
    question,offered_by,offered_at
  ) VALUES (
    NEW.tenant_id,NEW.conversation_id,NEW.turn_id,NEW.turn_event_id,
    btrim(NEW.event->>'question'),offered_by_user,NEW.occurred_at
  );
  INSERT INTO control_plane.clarification_options(
    tenant_id,conversation_id,offered_turn_id,option_id,
    preference_key,preference_value,option_label
  )
  SELECT NEW.tenant_id,NEW.conversation_id,NEW.turn_id,allowed.option_id,
         allowed.preference_key,allowed.preference_value,allowed.option_label
    FROM jsonb_array_elements(NEW.event->'options') AS item(option)
    JOIN control_plane.preference_value_allowlist AS allowed
      ON allowed.option_id=item.option->>'id'
     AND allowed.option_label=item.option->>'label'
     AND allowed.active;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversation_turn_event_capture_clarification
  ON control_plane.conversation_turn_events;
CREATE TRIGGER conversation_turn_event_capture_clarification
  AFTER INSERT ON control_plane.conversation_turn_events
  FOR EACH ROW
  WHEN ((NEW.event->>'type')='clarification')
  EXECUTE FUNCTION control_plane.capture_clarification_options();

-- Replace the four-argument RPC with a backward-call-compatible six-argument
-- form. Omitted trailing confirmation arguments still start an ordinary turn.
DROP FUNCTION public.begin_albert_turn(text,text,text,jsonb);
CREATE FUNCTION public.begin_albert_turn(
  p_conversation_id text,
  p_turn_id text,
  p_user_message text,
  p_runtime_profile jsonb,
  p_confirmation_turn_id text DEFAULT NULL,
  p_confirmation_option_id text DEFAULT NULL
)
RETURNS TABLE (
  conversation_id text,
  previous_response_id text,
  confirmed_option_id text,
  confirmed_preference text,
  confirmed_value text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  actor uuid:=auth.uid();
  selected_tenant text:=control_plane.require_current_tenant_id();
  resolved_conversation text:=p_conversation_id;
  next_turn integer;
  previous_provider_response text;
  existing_conversation_id text;
  existing_user_message text;
  existing_runtime_profile jsonb;
  existing_confirmation_turn text;
  existing_confirmation_option text;
  selected_option control_plane.clarification_options%ROWTYPE;
BEGIN
  IF actor IS NULL
     OR length(btrim(p_turn_id)) NOT BETWEEN 8 AND 128
     OR length(btrim(p_user_message)) NOT BETWEEN 1 AND 40000
     OR p_runtime_profile IS NULL
     OR jsonb_typeof(p_runtime_profile)<>'object'
     OR ((p_confirmation_turn_id IS NULL)<>(p_confirmation_option_id IS NULL)) THEN
    RAISE EXCEPTION 'turn input is invalid' USING ERRCODE='22023';
  END IF;

  -- Resolve exact idempotent replay before creating a conversation so a retry
  -- of a first turn (whose original conversation id was null) remains exact.
  SELECT turn.conversation_id,turn.user_message,turn.runtime_profile
    INTO existing_conversation_id,existing_user_message,existing_runtime_profile
    FROM control_plane.conversation_turns AS turn
    JOIN control_plane.conversations AS owned_conversation
      ON owned_conversation.tenant_id=turn.tenant_id
     AND owned_conversation.conversation_id=turn.conversation_id
   WHERE turn.tenant_id=selected_tenant AND turn.turn_id=p_turn_id
     AND turn.created_by=actor
     AND owned_conversation.created_by=actor;
  IF FOUND THEN
    IF (resolved_conversation IS NOT NULL AND existing_conversation_id<>resolved_conversation)
       OR existing_user_message<>btrim(p_user_message)
       OR existing_runtime_profile<>p_runtime_profile THEN
      RAISE EXCEPTION 'turn id replay does not match the immutable request' USING ERRCODE='23505';
    END IF;
    SELECT prompt.offered_turn_id,prompt.consumed_option_id,
           option.preference_key,option.preference_value
      INTO existing_confirmation_turn,existing_confirmation_option,
           confirmed_preference,confirmed_value
      FROM control_plane.clarification_prompts AS prompt
      JOIN control_plane.clarification_options AS option
        ON option.tenant_id=prompt.tenant_id
       AND option.offered_turn_id=prompt.offered_turn_id
       AND option.option_id=prompt.consumed_option_id
     WHERE prompt.tenant_id=selected_tenant AND prompt.consumed_turn_id=p_turn_id;
    IF (p_confirmation_turn_id IS NULL AND existing_confirmation_turn IS NOT NULL)
       OR (p_confirmation_turn_id IS NOT NULL AND (
         existing_confirmation_turn IS DISTINCT FROM p_confirmation_turn_id
         OR existing_confirmation_option IS DISTINCT FROM p_confirmation_option_id
       )) THEN
      RAISE EXCEPTION 'turn confirmation replay does not match the immutable request' USING ERRCODE='23505';
    END IF;
    conversation_id:=existing_conversation_id;
    confirmed_option_id:=existing_confirmation_option;
    SELECT completed.provider_response_id INTO previous_provider_response
      FROM control_plane.conversation_turns AS completed
     WHERE completed.tenant_id=selected_tenant
       AND completed.conversation_id=existing_conversation_id
       AND completed.status='completed'
       AND completed.turn_number<(
         SELECT existing.turn_number
           FROM control_plane.conversation_turns AS existing
          WHERE existing.tenant_id=selected_tenant AND existing.turn_id=p_turn_id
       )
     ORDER BY completed.turn_number DESC LIMIT 1;
    previous_response_id:=previous_provider_response;
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM control_plane.conversation_turns AS colliding_turn
     WHERE colliding_turn.tenant_id=selected_tenant
       AND colliding_turn.turn_id=p_turn_id
  ) THEN
    RAISE EXCEPTION 'turn id collision' USING ERRCODE='23505';
  END IF;

  IF resolved_conversation IS NULL THEN
    IF p_confirmation_turn_id IS NOT NULL THEN
      RAISE EXCEPTION 'a confirmation requires its existing conversation' USING ERRCODE='22023';
    END IF;
    resolved_conversation:=control_plane.generate_ulid();
    INSERT INTO control_plane.conversations(
      tenant_id,conversation_id,status,created_by
    ) VALUES (
      selected_tenant,resolved_conversation,'active',actor
    );
  ELSE
    PERFORM 1
      FROM control_plane.conversations AS conversation
     WHERE conversation.tenant_id=selected_tenant
       AND conversation.conversation_id=resolved_conversation
       AND conversation.created_by=actor
       AND conversation.status='active'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation was not found' USING ERRCODE='P0002';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('conversation:'||selected_tenant||':'||resolved_conversation,0)
  );
  IF EXISTS (
    SELECT 1 FROM control_plane.conversation_turns AS active_turn
     WHERE active_turn.tenant_id=selected_tenant
       AND active_turn.conversation_id=resolved_conversation
       AND active_turn.status='running'
  ) THEN
    RAISE EXCEPTION 'another turn is already running for this conversation' USING ERRCODE='55000';
  END IF;

  IF p_confirmation_turn_id IS NOT NULL THEN
    SELECT option.* INTO selected_option
      FROM control_plane.clarification_options AS option
      JOIN control_plane.clarification_prompts AS prompt
        ON prompt.tenant_id=option.tenant_id
       AND prompt.offered_turn_id=option.offered_turn_id
      JOIN control_plane.conversation_turns AS offered_turn
        ON offered_turn.tenant_id=option.tenant_id
       AND offered_turn.turn_id=option.offered_turn_id
      JOIN control_plane.answer_artifacts AS artifact
        ON artifact.tenant_id=offered_turn.tenant_id
       AND artifact.turn_id=offered_turn.turn_id
     WHERE option.tenant_id=selected_tenant
       AND option.conversation_id=resolved_conversation
       AND option.offered_turn_id=p_confirmation_turn_id
       AND option.option_id=p_confirmation_option_id
       AND prompt.consumed_turn_id IS NULL
       AND prompt.offered_by=actor
       AND offered_turn.created_by=actor
       AND offered_turn.status='completed'
       AND artifact.answer_state='clarification'
     FOR UPDATE OF prompt,option;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'clarification option was not found or was already consumed' USING ERRCODE='P0002';
    END IF;
  END IF;

  SELECT coalesce(max(turn.turn_number),0)+1 INTO next_turn
    FROM control_plane.conversation_turns AS turn
   WHERE turn.tenant_id=selected_tenant
     AND turn.conversation_id=resolved_conversation;
  SELECT turn.provider_response_id INTO previous_provider_response
    FROM control_plane.conversation_turns AS turn
   WHERE turn.tenant_id=selected_tenant
     AND turn.conversation_id=resolved_conversation
     AND turn.status='completed'
   ORDER BY turn.turn_number DESC LIMIT 1;

  INSERT INTO control_plane.conversation_turns(
    tenant_id,turn_id,conversation_id,turn_number,user_message,
    runtime_profile,status,created_by
  ) VALUES (
    selected_tenant,p_turn_id,resolved_conversation,next_turn,btrim(p_user_message),
    p_runtime_profile,'running',actor
  );
  IF p_confirmation_turn_id IS NOT NULL THEN
    UPDATE control_plane.clarification_prompts
       SET consumed_turn_id=p_turn_id,
           consumed_option_id=p_confirmation_option_id,
           consumed_at=now()
     WHERE tenant_id=selected_tenant
       AND offered_turn_id=p_confirmation_turn_id
       AND consumed_turn_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'clarification option was consumed concurrently' USING ERRCODE='55000';
    END IF;
    confirmed_option_id:=selected_option.option_id;
    confirmed_preference:=selected_option.preference_key;
    confirmed_value:=selected_option.preference_value;
  END IF;
  UPDATE control_plane.conversations AS active_conversation
     SET updated_at=now()
   WHERE active_conversation.tenant_id=selected_tenant
     AND active_conversation.conversation_id=resolved_conversation;

  conversation_id:=resolved_conversation;
  previous_response_id:=previous_provider_response;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON TABLE control_plane.preference_value_allowlist,
  control_plane.clarification_prompts,
  control_plane.clarification_options FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.begin_albert_turn(text,text,text,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.begin_albert_turn(text,text,text,jsonb,text,text) TO authenticated;

COMMENT ON TABLE control_plane.clarification_options IS
  'Server-resolved clarification choices; choosing one atomically consumes the whole prompt and authorizes one exact follow-on turn/key/value.';

COMMIT;
