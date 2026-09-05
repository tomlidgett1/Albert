-- Allow Grok 4.6 on the provider-neutral usage ledger and metering guards.

BEGIN;

ALTER TABLE control_plane.model_usage_ledger
  DROP CONSTRAINT IF EXISTS model_usage_ledger_model_check;
ALTER TABLE control_plane.model_usage_ledger
  ADD CONSTRAINT model_usage_ledger_model_check
  CHECK (model IN (
    'gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','grok-4.6',
    'claude-opus-5','claude-sonnet-5'
  ));

DO $$
DECLARE
  definition text;
  gpt_guard constant text := 'p_metering->>''model'' NOT IN (''gpt-5.6-sol'',''gpt-5.6-terra'',''gpt-5.6-luna'')';
  claude_guard constant text := 'p_metering->>''model'' NOT IN (''gpt-5.6-sol'',''gpt-5.6-terra'',''gpt-5.6-luna'',''claude-opus-5'',''claude-sonnet-5'')';
  grok_guard constant text := 'p_metering->>''model'' NOT IN (''gpt-5.6-sol'',''gpt-5.6-terra'',''gpt-5.6-luna'',''grok-4.6'',''claude-opus-5'',''claude-sonnet-5'')';
  grok_gpt_guard constant text := 'p_metering->>''model'' NOT IN (''gpt-5.6-sol'',''gpt-5.6-terra'',''gpt-5.6-luna'',''grok-4.6'')';
  proc oid;
BEGIN
  FOREACH proc IN ARRAY ARRAY[
    'control_plane.finalize_answer_artifact(text,uuid,text,text,text,jsonb,text,text,jsonb,jsonb)'::regprocedure,
    'control_plane.record_model_usage_checkpoint(text,uuid,text,text,text,jsonb,jsonb,text)'::regprocedure,
    'control_plane.finalize_semantic_v2_answer_artifact(text,uuid,text,text,text,jsonb,text,text,jsonb,jsonb,jsonb,text)'::regprocedure
  ]
  LOOP
    definition := pg_get_functiondef(proc);
    IF position(grok_guard IN definition)>0 OR position(grok_gpt_guard IN definition)>0 THEN
      NULL;
    ELSIF position(claude_guard IN definition)>0 THEN
      EXECUTE replace(definition, claude_guard, grok_guard);
    ELSIF position(gpt_guard IN definition)>0 THEN
      EXECUTE replace(definition, gpt_guard, grok_gpt_guard);
    ELSE
      RAISE EXCEPTION '% model guard drifted; refusing an unsafe migration', proc::regprocedure;
    END IF;
  END LOOP;
END;
$$;

COMMIT;

