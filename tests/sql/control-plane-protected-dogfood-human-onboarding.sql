\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'protected onboarding assertion failed: %',message;
  END IF;
END;
$$;

-- The issuer requires the independently observed candidate worker barrier.
SELECT journey->>'journeyId' AS first_journey_id
FROM (
  SELECT control_plane.issue_protected_dogfood_onboarding_journey(
    'dddddddddddddddddddddddddddddddddddddddd','ci-dogfood-deployment-1',
    encode(extensions.digest(convert_to(repeat('A',43),'UTF8'),'sha256'),'hex'),900
  ) AS journey
) issued \gset

DO $$
BEGIN
  PERFORM control_plane.issue_protected_dogfood_onboarding_journey(
    'dddddddddddddddddddddddddddddddddddddddd','ci-dogfood-deployment-1',
    encode(extensions.digest(convert_to(repeat('Z',43),'UTF8'),'sha256'),'hex'),900
  );
  RAISE EXCEPTION 'a second active one-use journey was issued';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

UPDATE control_plane.protected_dogfood_onboarding_journeys
   SET status='expired'
 WHERE journey_id=:'first_journey_id';

SELECT journey->>'journeyId' AS journey_id,
       journey->>'issuedAt' AS issued_at
FROM (
  SELECT control_plane.issue_protected_dogfood_onboarding_journey(
    'dddddddddddddddddddddddddddddddddddddddd','ci-dogfood-deployment-1',
    encode(extensions.digest(convert_to(repeat('C',43),'UTF8'),'sha256'),'hex'),900
  ) AS journey
) issued \gset

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '65000000-0000-4000-8000-000000000065','authenticated','authenticated',
  'protected-onboarding-human@albert.invalid','',
  :'issued_at'::timestamptz+interval '40 milliseconds',
  '{"provider":"email","providers":["email"]}','{}',
  :'issued_at'::timestamptz+interval '10 milliseconds',
  :'issued_at'::timestamptz+interval '40 milliseconds'
);
INSERT INTO auth.audit_log_entries(id,payload,created_at) VALUES
  ('65000000-0000-4000-8000-000000000001',json_build_object(
    'actor_id','65000000-0000-4000-8000-000000000065',
    'action','user_confirmation_requested'
  ),:'issued_at'::timestamptz+interval '20 milliseconds'),
  ('65000000-0000-4000-8000-000000000002',json_build_object(
    'actor_id','65000000-0000-4000-8000-000000000065',
    'action','user_signedup'
  ),:'issued_at'::timestamptz+interval '30 milliseconds');

INSERT INTO control_plane.tenants(
  tenant_id,slug,display_name,status,created_by,created_at,updated_at
) VALUES (
  '01H00000000000000000006501','protected-human-onboarding-fixture',
  'Protected human onboarding fixture','active',
  '65000000-0000-4000-8000-000000000065',
  :'issued_at'::timestamptz+interval '50 milliseconds',
  :'issued_at'::timestamptz+interval '50 milliseconds'
);
INSERT INTO control_plane.memberships(
  tenant_id,membership_id,user_id,role,status,created_by,created_at,updated_at
) VALUES (
  '01H00000000000000000006501','01H00000000000000000006502',
  '65000000-0000-4000-8000-000000000065','owner','active',
  '65000000-0000-4000-8000-000000000065',
  :'issued_at'::timestamptz+interval '50 milliseconds',
  :'issued_at'::timestamptz+interval '50 milliseconds'
);
INSERT INTO control_plane.audit_log(
  tenant_id,audit_id,actor_user_id,actor_type,action,resource_type,
  resource_id,audit_metadata,occurred_at
) VALUES (
  '01H00000000000000000006501','01H00000000000000000006503',
  '65000000-0000-4000-8000-000000000065','user','tenant.bootstrap','tenant',
  '01H00000000000000000006501','{}',
  :'issued_at'::timestamptz+interval '50 milliseconds'
);

SELECT pg_sleep(0.1);
SELECT set_config(
  'request.jwt.claim.sub','65000000-0000-4000-8000-000000000065',true
);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"65000000-0000-4000-8000-000000000065","role":"authenticated","app_metadata":{"active_tenant_id":"01H00000000000000000006501"}}',
  true
);
SELECT set_config('test.journey_id',:'journey_id',true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.albert_claim_protected_dogfood_onboarding_journey(
    current_setting('test.journey_id',true),repeat('D',43),
    encode(extensions.digest(convert_to(repeat('B',43),'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to('Albert acceptance browser/1','UTF8'),'sha256'),'hex')
  );
  RAISE EXCEPTION 'an incorrect one-use code claimed the journey';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;
SELECT claim->>'claimDigest' AS claim_digest,claim->>'claimedAt' AS claimed_at
FROM (
  SELECT public.albert_claim_protected_dogfood_onboarding_journey(
    :'journey_id',repeat('C',43),
    encode(extensions.digest(convert_to(repeat('B',43),'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to('Albert acceptance browser/1','UTF8'),'sha256'),'hex')
  ) AS claim
) claimed \gset
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT browser_nonce_hash=encode(
      extensions.digest(convert_to(repeat('B',43),'UTF8'),'sha256'),'hex'
    ) AND claim_binding->>'browserNonceHash'=browser_nonce_hash
     AND claim_binding->>'userAgentHash'=user_agent_hash
     AND position(repeat('C',43) IN claim_binding::text)=0
     AND position(repeat('B',43) IN claim_binding::text)=0
     FROM control_plane.protected_dogfood_onboarding_claims
    WHERE journey_id=:'journey_id'),
  'claim must persist only exact continuity digests and no raw one-use value'
);

DO $$
BEGIN
  PERFORM control_plane.complete_protected_dogfood_onboarding_receipt(
    current_setting('test.journey_id',true),
    '65000000-0000-4000-8000-000000000065',
    '01H00000000000000000006501',
    encode(extensions.digest(convert_to(repeat('B',43),'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to('Albert acceptance browser/1','UTF8'),'sha256'),'hex')
  );
  RAISE EXCEPTION 'a receipt completed without a post-claim managed Auth login';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

INSERT INTO auth.audit_log_entries(id,payload,created_at) VALUES (
  '65000000-0000-4000-8000-000000000003',json_build_object(
    'actor_id','65000000-0000-4000-8000-000000000065','action','login'
  ),:'claimed_at'::timestamptz+interval '10 milliseconds'
);
SELECT pg_sleep(0.05);

DO $$
BEGIN
  PERFORM control_plane.complete_protected_dogfood_onboarding_receipt(
    current_setting('test.journey_id',true),
    '65000000-0000-4000-8000-000000000065',
    '01H00000000000000000006501',repeat('0',64),
    encode(extensions.digest(convert_to('Albert acceptance browser/1','UTF8'),'sha256'),'hex')
  );
  RAISE EXCEPTION 'a different browser nonce completed the receipt';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

DO $$
BEGIN
  PERFORM control_plane.complete_protected_dogfood_onboarding_receipt(
    current_setting('test.journey_id',true),
    '65000000-0000-4000-8000-000000000065',
    '01H00000000000000000006501',
    encode(extensions.digest(convert_to(repeat('B',43),'UTF8'),'sha256'),'hex'),
    repeat('0',64)
  );
  RAISE EXCEPTION 'a different user-agent binding completed the receipt';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

DO $$
BEGIN
  PERFORM control_plane.complete_protected_dogfood_onboarding_receipt(
    current_setting('test.journey_id',true),
    '65000000-0000-4000-8000-000000000066',
    '01H00000000000000000006501',
    encode(extensions.digest(convert_to(repeat('B',43),'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to('Albert acceptance browser/1','UTF8'),'sha256'),'hex')
  );
  RAISE EXCEPTION 'another user completed the receipt';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

SELECT receipt->>'receiptDigest' AS receipt_digest
FROM (
  SELECT control_plane.complete_protected_dogfood_onboarding_receipt(
    :'journey_id','65000000-0000-4000-8000-000000000065',
    '01H00000000000000000006501',
    encode(extensions.digest(convert_to(repeat('B',43),'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to('Albert acceptance browser/1','UTF8'),'sha256'),'hex')
  ) AS receipt
) completed \gset

SELECT pg_temp.assert_true(
  (SELECT status='completed' AND completed_at IS NOT NULL
     FROM control_plane.protected_dogfood_onboarding_journeys
    WHERE journey_id=:'journey_id'),
  'legitimate claim, post-claim login, and matching browser receipt must complete'
);
SELECT pg_temp.assert_true(
  (SELECT receipt_digest=:'receipt_digest'
     AND browser_nonce_hash=(
       SELECT browser_nonce_hash
         FROM control_plane.protected_dogfood_onboarding_claims
        WHERE journey_id=:'journey_id'
     )
     FROM control_plane.protected_dogfood_onboarding_receipts
    WHERE journey_id=:'journey_id'),
  'receipt must be digest-bound to the immutable claim continuity evidence'
);

DO $$
BEGIN
  UPDATE control_plane.protected_dogfood_onboarding_claims
     SET browser_nonce_hash=repeat('f',64)
   WHERE journey_id=current_setting('test.journey_id',true);
  RAISE EXCEPTION 'append-only claim was mutated';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM control_plane.complete_protected_dogfood_onboarding_receipt(
    current_setting('test.journey_id',true),
    '65000000-0000-4000-8000-000000000065',
    '01H00000000000000000006501',repeat('0',64),repeat('0',64)
  );
  RAISE EXCEPTION 'authenticated web role completed an operator-only receipt';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  PERFORM public.albert_claim_protected_dogfood_onboarding_journey(
    current_setting('test.journey_id',true),repeat('C',43),repeat('0',64),repeat('0',64)
  );
  RAISE EXCEPTION 'completed one-use journey was replayed';
EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
END;
$$;

ROLLBACK;
