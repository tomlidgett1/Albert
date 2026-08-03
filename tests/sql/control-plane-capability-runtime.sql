\set ON_ERROR_STOP on

BEGIN;
SET LOCAL ROLE albert_operator_diagnostic_control;

DO $$
DECLARE
  grant_record jsonb;
  token jsonb;
BEGIN
  IF session_user<>'albert_operator_diagnostic_control_runtime' THEN
    RAISE EXCEPTION 'capability test did not connect as the exact runtime login';
  END IF;
  grant_record:=control_plane.claim_operator_diagnostic_reveal(
    '01H00000000000000000003802'
  );
  token:=(grant_record->>'analytical_capability')::jsonb;
  IF token->'payload'->>'tenant_id'<>'01H00000000000000000003801'
     OR token->'payload'->>'audience'<>'analytical:diagnostic'
     OR token->'payload'->>'scope'<>'diagnostic'
     OR token->>'signature' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'diagnostic analytical capability claims are invalid';
  END IF;
END;
$$;

DO $$
BEGIN
  PERFORM control_plane.claim_operator_diagnostic_reveal(
    '01H00000000000000000003802'
  );
  RAISE EXCEPTION 'one-use diagnostic reveal was claimed twice';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

SELECT control_plane.complete_operator_diagnostic_reveal(
  '01H00000000000000000003802','completed',0,NULL
);
COMMIT;
