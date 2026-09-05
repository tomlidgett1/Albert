-- Admit Gemini 3.7 Flash to the provider-neutral usage ledger and every
-- current metering/finalization guard. No provider payload is stored.

BEGIN;

ALTER TABLE control_plane.model_usage_ledger
  DROP CONSTRAINT IF EXISTS model_usage_ledger_model_check;
ALTER TABLE control_plane.model_usage_ledger
  ADD CONSTRAINT model_usage_ledger_model_check
    CHECK (model IN (
      'gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','grok-4.6',
      'claude-haiku-4-5-20251001','claude-opus-5','claude-sonnet-5',
      'gemini-3.7-flash'
    ));

DO $migration$
DECLARE
  definition text;
  updated_definition text;
  proc oid;
BEGIN
  FOREACH proc IN ARRAY ARRAY[
    'control_plane.finalize_answer_artifact(text,uuid,text,text,text,jsonb,text,text,jsonb,jsonb)'::regprocedure,
    'control_plane.record_model_usage_checkpoint(text,uuid,text,text,text,jsonb,jsonb,text)'::regprocedure,
    'control_plane.finalize_semantic_v2_answer_artifact(text,uuid,text,text,text,jsonb,text,text,jsonb,jsonb,jsonb,text)'::regprocedure,
    'public.albert_record_turn_usage(text,text,jsonb)'::regprocedure
  ]
  LOOP
    definition := pg_get_functiondef(proc);
    IF position('gemini-3.7-flash' IN definition) > 0 THEN
      CONTINUE;
    END IF;

    updated_definition := replace(
      definition,
      $needle$'claude-haiku-4-5-20251001',$needle$,
      $replacement$'claude-haiku-4-5-20251001','gemini-3.7-flash',$replacement$
    );
    IF updated_definition = definition THEN
      updated_definition := replace(
        definition,
        $needle$'claude-haiku-4-5-20251001')$needle$,
        $replacement$'claude-haiku-4-5-20251001','gemini-3.7-flash')$replacement$
      );
    END IF;
    IF updated_definition = definition THEN
      RAISE EXCEPTION '% model guard drifted; refusing an unsafe migration', proc::regprocedure;
    END IF;
    EXECUTE updated_definition;
  END LOOP;
END;
$migration$;

NOTIFY pgrst, 'reload schema';

COMMIT;
