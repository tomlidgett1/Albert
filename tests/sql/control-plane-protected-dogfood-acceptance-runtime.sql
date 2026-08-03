\set ON_ERROR_STOP on

BEGIN;
SET LOCAL ROLE albert_operator_diagnostic_control;

DO $$
BEGIN
  IF session_user<>'albert_operator_diagnostic_control_runtime' THEN
    RAISE EXCEPTION 'protected dogfood test did not use the exact diagnostic runtime login';
  END IF;
  BEGIN
    PERFORM control_plane.capture_protected_dogfood_acceptance(
      'dddddddddddddddddddddddddddddddddddddddd','ci-missing-deployment',
      '01H00000000000000000005401',
      '{
        "lightspeed-r":"01H00000000000000000005411",
        "xero":"01H00000000000000000005412",
        "deputy":"01H00000000000000000005413"
      }'::jsonb,
      '01H00000000000000000005404',30,
      '01H00000000000000000005405','01H00000000000000000005406','sales',
      '01H00000000000000000005407','01H00000000000000000005408'
    );
    RAISE EXCEPTION 'capture accepted a deployment without exact candidate workers';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE '%candidate deployment does not have all fresh worker barriers%' THEN
      RAISE;
    END IF;
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM control_plane.capture_protected_dogfood_acceptance(
      'dddddddddddddddddddddddddddddddddddddddd','ci-dogfood-deployment-1',
      '01H00000000000000000005401',
      '{
        "lightspeed-r":"01H00000000000000000005411",
        "xero":"01H00000000000000000005412",
        "deputy":"01H00000000000000000005413"
      }'::jsonb,
      '01H00000000000000000005404',30,
      '01H00000000000000000005405','01H00000000000000000005406','sales',
      '01H00000000000000000005407','01H00000000000000000005408'
    );
    RAISE EXCEPTION 'capture accepted selectors without live OAuth evidence';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE '%all three dogfood OAuth connections must be live and healthy%' THEN
      RAISE;
    END IF;
  END;
END;
$$;

SELECT
  lease->>'leaseId' AS lease_id,
  lease->>'conversationId' AS conversation_id,
  lease->>'turnId' AS turn_id
FROM (
  SELECT control_plane.issue_protected_dogfood_semantic_turn(
    '01H00000000000000000005401',
    'dddddddddddddddddddddddddddddddddddddddd',
    'ci-dogfood-deployment-1','540000000000000054',1,'numeric_golden',1
  ) AS lease
) issued \gset dogfood_

SELECT control_plane.finish_protected_dogfood_semantic_turn(
  :'dogfood_lease_id',true,
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
);
SELECT set_config('dogfood.lease_id',:'dogfood_lease_id',true);

DO $$
BEGIN
  PERFORM control_plane.issue_protected_dogfood_semantic_turn(
    '01H00000000000000000005401',
    'dddddddddddddddddddddddddddddddddddddddd',
    'ci-dogfood-deployment-1','540000000000000054',1,'numeric_golden',1
  );
  RAISE EXCEPTION 'one workflow case/pass received a second semantic turn';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

DO $$
BEGIN
  PERFORM control_plane.finish_protected_dogfood_semantic_turn(
    current_setting('dogfood.lease_id',true),true,
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  );
  RAISE EXCEPTION 'one semantic lease was finalized twice';
EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE '55000' THEN NULL;
END;
$$;

SELECT control_plane.consume_protected_dogfood_acceptance(
  '01H00000000000000000005403',
  'dddddddddddddddddddddddddddddddddddddddd',
  'ce957ff9b4cf7efc2d3a244934ba1d2a6a4818a8e9e6a294a5b738394b9d4fef',
  '540000000000000055','tomlidgett1/Albert'
);

DO $$
BEGIN
  PERFORM control_plane.consume_protected_dogfood_acceptance(
    '01H00000000000000000005403',
    'dddddddddddddddddddddddddddddddddddddddd',
    'ce957ff9b4cf7efc2d3a244934ba1d2a6a4818a8e9e6a294a5b738394b9d4fef',
    '540000000000000056','tomlidgett1/Albert'
  );
  RAISE EXCEPTION 'one snapshot authorized a second release';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

COMMIT;
