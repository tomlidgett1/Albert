\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'semantic release qualification assertion failed: %', message;
  END IF;
END;
$$;

-- Seed immutable release evidence as the CI superuser. The release process
-- itself connects as the dedicated deployer and SET ROLEs to the NOLOGIN
-- migration owner before it reads these rows.
INSERT INTO control_plane.semantic_v2_drafts(
  draft_id,name,base_publication_hash,revision,status,manifest,manifest_hash,created_by
) VALUES (
  '01K1ZZZZZZ0000000000000200','Release qualification fixture',repeat('b',64),1,
  'publishable','{"schemaVersion":"2"}'::jsonb,repeat('a',64),
  '10000000-0000-4000-8000-000000000001'
);

INSERT INTO control_plane.semantic_v2_draft_revisions(
  draft_id,revision,manifest,manifest_hash,change_summary,created_by
) VALUES (
  '01K1ZZZZZZ0000000000000200',1,'{"schemaVersion":"2"}'::jsonb,repeat('a',64),
  'Release qualification fixture',
  '10000000-0000-4000-8000-000000000001'
);

INSERT INTO control_plane.semantic_v2_validation_reports(
  validation_id,draft_id,draft_revision,manifest_hash,status,issues,
  deterministic_test_receipt,created_by
) VALUES (
  '01K1ZZZZZZ0000000000000201','01K1ZZZZZZ0000000000000200',1,repeat('a',64),
  'passed','[]'::jsonb,'{}'::jsonb,
  '10000000-0000-4000-8000-000000000001'
);

INSERT INTO control_plane.semantic_v2_profile_receipts(
  profile_receipt_hash,publication_hash,tenant_digest,status,artifact,created_by
) VALUES (
  repeat('c',64),repeat('b',64),repeat('d',64),'complete',
  jsonb_build_object(
    'publicationHash',repeat('b',64),
    'tenantDigest',repeat('d',64),
    'status','complete'
  ),
  '10000000-0000-4000-8000-000000000001'
);

INSERT INTO control_plane.semantic_v2_publications(
  publication_hash,registry_version,schema_version,artifact,object_counts,
  validation_id,source_draft_id,source_draft_revision,created_by
) VALUES (
  repeat('e',64),'2.0.0',2,'{"schemaVersion":"2"}'::jsonb,'{}'::jsonb,
  '01K1ZZZZZZ0000000000000201','01K1ZZZZZZ0000000000000200',1,
  '10000000-0000-4000-8000-000000000001'
);

SET LOCAL ROLE albert_control_migration_owner;

SELECT pg_temp.assert_true(
  (SELECT count(*)=1
     FROM control_plane.semantic_v2_publications
    WHERE publication_hash=repeat('e',64)),
  'the protected qualifier must see the exact immutable publication'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1
     FROM control_plane.semantic_v2_drafts
    WHERE draft_id='01K1ZZZZZZ0000000000000200'),
  'the protected qualifier must see publication draft lineage'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1
     FROM control_plane.semantic_v2_draft_revisions
    WHERE draft_id='01K1ZZZZZZ0000000000000200' AND revision=1),
  'the protected qualifier must see the immutable initial draft revision'
);
SELECT pg_temp.assert_true(
  (SELECT count(*)=1
     FROM control_plane.semantic_v2_profile_receipts
    WHERE profile_receipt_hash=repeat('c',64)),
  'the protected qualifier must see registered live-profile evidence'
);

INSERT INTO control_plane.semantic_v2_activation_qualifications(
  qualification_id,publication_hash,commit_sha,status,deterministic_receipt,
  model_evaluation_receipt,created_by
) VALUES (
  '01K1ZZZZZZ0000000000000202',repeat('e',64),repeat('f',40),'passed',
  '{"status":"passed"}'::jsonb,'{"status":"passed"}'::jsonb,
  '10000000-0000-4000-8000-000000000001'
);

-- Qualification may append its immutable receipt, but may not mutate semantic
-- drafts or manufacture publication artifacts.
DO $$
BEGIN
  BEGIN
    INSERT INTO control_plane.semantic_v2_drafts(
      draft_id,name,revision,status,manifest,manifest_hash,created_by
    ) VALUES (
      '01K1ZZZZZZ0000000000000203','Forbidden qualifier draft',1,'draft',
      '{"schemaVersion":"2"}'::jsonb,repeat('1',64),
      '10000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'release qualifier unexpectedly inserted a semantic draft';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT count(*)=1
     FROM control_plane.semantic_v2_activation_qualifications
    WHERE qualification_id='01K1ZZZZZZ0000000000000202'),
  'the release qualification receipt must be durably appendable'
);

ROLLBACK;
