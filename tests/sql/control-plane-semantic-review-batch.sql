\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'semantic review batch assertion failed: %', message;
  END IF;
END;
$$;

INSERT INTO auth.users(
  id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES (
  '93000000-0000-4000-8000-000000000009','authenticated','authenticated',
  'semantic-reviewer@albert.invalid','',now(),'{}','{}',now(),now()
);
INSERT INTO control_plane.internal_operators(
  user_id,email,enabled,reason
) VALUES (
  '93000000-0000-4000-8000-000000000009',
  'semantic-reviewer@albert.invalid',true,'Semantic review batch integration fixture.'
);

INSERT INTO control_plane.semantic_v2_drafts(
  draft_id,name,revision,status,manifest,manifest_hash,created_by
) VALUES (
  '01K1ZZZZZZ0000000000000210','Semantic review batch fixture',1,'review',
  '{
    "schemaVersion":"2",
    "measures":[
      {"id":"measure.fixture.tier1","semanticState":"verified","riskTier":"tier_1"},
      {"id":"measure.fixture.tier2","semanticState":"derived","riskTier":"tier_2"},
      {"id":"measure.fixture.atomic","semanticState":"verified","riskTier":"tier_1"}
    ],
    "relationships":[],
    "topics":[],
    "sourceObjects":[]
  }'::jsonb,
  repeat('2',64),'93000000-0000-4000-8000-000000000009'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub','93000000-0000-4000-8000-000000000009',true
);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"93000000-0000-4000-8000-000000000009","role":"authenticated","app_metadata":{}}',
  true
);

SELECT public.albert_semantic_v2_record_review_batch(
  '01K1ZZZZZZ0000000000000210',1,
  '[
    {
      "reviewId":"01K1ZZZZZZ0000000000000211",
      "objectId":"measure.fixture.tier1",
      "riskTier":"tier_1",
      "disposition":"approved",
      "notes":"Reviewed against the governed fixture."
    },
    {
      "reviewId":"01K1ZZZZZZ0000000000000212",
      "objectId":"measure.fixture.tier2",
      "riskTier":"tier_2",
      "disposition":"approved",
      "notes":"Reviewed against the governed fixture."
    }
  ]'::jsonb
) AS batch_result \gset

SELECT pg_temp.assert_true(
  ((:'batch_result')::jsonb->>'recorded')::integer=2,
  'the batch must report every explicitly recorded decision'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2
     FROM control_plane.semantic_v2_object_reviews
    WHERE draft_id='01K1ZZZZZZ0000000000000210'
      AND reviewer_id='93000000-0000-4000-8000-000000000009'),
  'one reviewer must record exactly one decision per selected object'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=2
     FROM control_plane.semantic_v2_object_reviews
    WHERE draft_id='01K1ZZZZZZ0000000000000210'
      AND reviewer_id='93000000-0000-4000-8000-000000000009'
      AND notes='Reviewed against the governed fixture.'),
  'the review writer must persist the submitted evidence notes'
);
SELECT pg_temp.assert_true(
  (public.albert_semantic_v2_admin_draft_reviews(
    '01K1ZZZZZZ0000000000000210',1
  )->>'count')::integer=2
  AND NOT (public.albert_semantic_v2_admin_draft_reviews(
    '01K1ZZZZZZ0000000000000210',1
  )->>'truncated')::boolean
  AND jsonb_array_length(
    public.albert_semantic_v2_admin_draft_reviews(
      '01K1ZZZZZZ0000000000000210',1
    )->'reviews'
  )=2,
  'the exact-revision review projection must not lose approvals to a global limit'
);

DO $$
BEGIN
  BEGIN
    PERFORM public.albert_semantic_v2_record_review_batch(
      '01K1ZZZZZZ0000000000000210',1,
      '[
        {
          "reviewId":"01K1ZZZZZZ0000000000000213",
          "objectId":"measure.fixture.atomic",
          "riskTier":"tier_1",
          "disposition":"approved",
          "notes":"Reviewed against the governed fixture."
        },
        {
          "reviewId":"01K1ZZZZZZ0000000000000214",
          "objectId":"measure.fixture.not_reviewable",
          "riskTier":"tier_1",
          "disposition":"approved",
          "notes":"Reviewed against the governed fixture."
        }
      ]'::jsonb
    );
    RAISE EXCEPTION 'an invalid review batch unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$$;
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM control_plane.semantic_v2_object_reviews
    WHERE draft_id='01K1ZZZZZZ0000000000000210'
      AND object_id='measure.fixture.atomic'
  ),
  'one invalid decision must roll back the complete review batch'
);

DO $$
BEGIN
  BEGIN
    PERFORM public.albert_semantic_v2_record_review_batch(
      '01K1ZZZZZZ0000000000000210',1,
      '[
        {
          "reviewId":"01K1ZZZZZZ0000000000000215",
          "objectId":"measure.fixture.atomic",
          "riskTier":"tier_1",
          "disposition":"approved",
          "notes":"Reviewed against the governed fixture."
        },
        {
          "reviewId":"01K1ZZZZZZ0000000000000216",
          "objectId":"measure.fixture.atomic",
          "riskTier":"tier_1",
          "disposition":"approved",
          "notes":"Reviewed against the governed fixture."
        }
      ]'::jsonb
    );
    RAISE EXCEPTION 'a duplicate-object review batch unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$$;

ROLLBACK;
