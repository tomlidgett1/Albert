\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'conversation-lease assertion failed: %',message;
  END IF;
END;
$$;

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '52000000-0000-4000-8000-000000000005','authenticated','authenticated',
  'lease-owner@albert.invalid','',now(),'{}','{}',now(),now()
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','52000000-0000-4000-8000-000000000005',true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"52000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{}}',
  true
);
SELECT * FROM public.bootstrap_albert_tenant(
  'Conversation Lease Tenant','Australia/Melbourne'
) \gset tenant_
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"52000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'tenant_tenant_id'
  ),
  true
);
SELECT * FROM public.begin_albert_turn(
  NULL,'01K4AAAAAAAAAAAAAAAAAAAAAA','Start a long analysis',
  '{"model":"gpt-5.6-sol","reasoningEffort":"medium","fastMode":false,"runtime":"openai-agents-sdk"}'::jsonb
) \gset first_

RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT status='running'
       AND lease_expires_at>created_at
       AND lease_expires_at<=created_at+interval '6 minutes 1 second'
     FROM control_plane.conversation_turns
    WHERE tenant_id=:'tenant_tenant_id' AND turn_id='01K4AAAAAAAAAAAAAAAAAAAAAA'),
  'a new running turn must receive the fixed server lease'
);

SET LOCAL ROLE authenticated;
SELECT set_config('test.lease_conversation_id',:'first_conversation_id',true);
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.begin_albert_turn(
      current_setting('test.lease_conversation_id'),
      '01K4BBBBBBBBBBBBBBBBBBBBBB','Do not overlap',
      '{"model":"gpt-5.6-sol","reasoningEffort":"medium","fastMode":false,"runtime":"openai-agents-sdk"}'::jsonb
    );
    RAISE EXCEPTION 'a live turn lease allowed an overlapping turn';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END;
$$;

RESET ROLE;
UPDATE control_plane.conversation_turns
   SET lease_expires_at=clock_timestamp()-interval '1 second'
 WHERE tenant_id=:'tenant_tenant_id' AND turn_id='01K4AAAAAAAAAAAAAAAAAAAAAA';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','52000000-0000-4000-8000-000000000005',true);
SELECT set_config(
  'request.jwt.claims',
  format(
    '{"sub":"52000000-0000-4000-8000-000000000005","role":"authenticated","app_metadata":{"active_tenant_id":"%s"}}',
    :'tenant_tenant_id'
  ),
  true
);
SELECT * FROM public.begin_albert_turn(
  :'first_conversation_id','01K4CCCCCCCCCCCCCCCCCCCCCC','Recover after process loss',
  '{"model":"gpt-5.6-sol","reasoningEffort":"medium","fastMode":false,"runtime":"openai-agents-sdk"}'::jsonb
) \gset second_

RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT status='failed' AND result_digest='turn_lease_expired'
     FROM control_plane.conversation_turns
    WHERE tenant_id=:'tenant_tenant_id' AND turn_id='01K4AAAAAAAAAAAAAAAAAAAAAA')
  AND
  (SELECT status='running'
     FROM control_plane.conversation_turns
    WHERE tenant_id=:'tenant_tenant_id' AND turn_id='01K4CCCCCCCCCCCCCCCCCCCCCC'),
  'begin must atomically reap an expired runner before opening its replacement'
);

RESET ROLE;
UPDATE control_plane.conversation_turns
   SET lease_expires_at=clock_timestamp()-interval '1 second'
 WHERE tenant_id=:'tenant_tenant_id' AND turn_id='01K4CCCCCCCCCCCCCCCCCCCCCC';
SELECT pg_temp.assert_true(
  control_plane.reap_expired_conversation_turns()=1,
  'the scheduled all-tenant reaper must recover an abandoned turn'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2
     FROM control_plane.audit_log
    WHERE tenant_id=:'tenant_tenant_id'
      AND action='conversation.turn_lease_expired')
  AND EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname='albert-conversation-turn-reaper'
       AND schedule='* * * * *'
       AND command='SELECT control_plane.reap_expired_conversation_turns()'
  ),
  'both recovery paths must be audited and the fixed cron job installed'
);

ROLLBACK;
