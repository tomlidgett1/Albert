-- Stop admitting Gemini 3.7 Flash on new metering and finalization. Keep
-- gemini-3.7-flash on the usage-ledger check so historical eval rows remain
-- valid.

BEGIN;

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
    IF position('gemini-3.7-flash' IN definition) = 0 THEN
      CONTINUE;
    END IF;

    updated_definition := replace(
      definition,
      $needle$'claude-haiku-4-5-20251001','gemini-3.7-flash'$needle$,
      $replacement$'claude-haiku-4-5-20251001'$replacement$
    );
    IF updated_definition = definition THEN
      updated_definition := replace(
        definition,
        $needle$'gemini-3.7-flash','claude-haiku-4-5-20251001'$needle$,
        $replacement$'claude-haiku-4-5-20251001'$replacement$
      );
    END IF;
    IF updated_definition = definition THEN
      updated_definition := replace(
        definition,
        $needle$,'gemini-3.7-flash'$needle$,
        $replacement$$replacement$
      );
    END IF;
    IF updated_definition = definition THEN
      RAISE EXCEPTION '% Gemini guard drifted; refusing an unsafe migration', proc::regprocedure;
    END IF;
    EXECUTE updated_definition;
  END LOOP;
END;
$migration$;

NOTIFY pgrst, 'reload schema';

COMMIT;
