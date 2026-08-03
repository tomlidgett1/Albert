\set ON_ERROR_STOP on

BEGIN;

-- Purpose-built relations make every attestation class executable without
-- coupling this contract to connector fixture columns. They are transactionally
-- removed at the end of the test and owned by the verifier's SECURITY DEFINER
-- role so information_schema discovery has the same visibility as production.
CREATE TABLE ingestion.deletion_attestation_staging_test (
  tenant_id text NOT NULL,
  connection_id text NOT NULL
);
CREATE TABLE core.deletion_attestation_canonical_test (
  tenant_id text NOT NULL,
  primary_connection_id text NOT NULL
);
CREATE TABLE quality.deletion_attestation_reconciliation_test (
  tenant_id text NOT NULL,
  connection_id text NOT NULL
);
CREATE TABLE semantic_internal.deletion_attestation_identity_test (
  tenant_id text NOT NULL,
  connection_id text NOT NULL
);
CREATE TABLE semantic_internal.deletion_attestation_embedding_test (
  tenant_id text NOT NULL,
  connection_id text NOT NULL
);
CREATE TABLE semantic_internal.deletion_attestation_cache_test (
  tenant_id text NOT NULL,
  connection_id text NOT NULL
);
CREATE TABLE semantic_internal.deletion_attestation_other_test (
  tenant_id text NOT NULL,
  connection_id text NOT NULL
);
CREATE TABLE mart.deletion_attestation_retained_test (
  tenant_id text NOT NULL
);

ALTER TABLE ingestion.deletion_attestation_staging_test OWNER TO albert_migration_owner;
ALTER TABLE core.deletion_attestation_canonical_test OWNER TO albert_migration_owner;
ALTER TABLE quality.deletion_attestation_reconciliation_test OWNER TO albert_migration_owner;
ALTER TABLE semantic_internal.deletion_attestation_identity_test OWNER TO albert_migration_owner;
ALTER TABLE semantic_internal.deletion_attestation_embedding_test OWNER TO albert_migration_owner;
ALTER TABLE semantic_internal.deletion_attestation_cache_test OWNER TO albert_migration_owner;
ALTER TABLE semantic_internal.deletion_attestation_other_test OWNER TO albert_migration_owner;
ALTER TABLE mart.deletion_attestation_retained_test OWNER TO albert_migration_owner;

INSERT INTO ingestion.deletion_attestation_staging_test
VALUES ('01H00000000000000000000701','01H00000000000000000000702');
INSERT INTO core.deletion_attestation_canonical_test
VALUES ('01H00000000000000000000701','01H00000000000000000000702');
INSERT INTO quality.deletion_attestation_reconciliation_test
VALUES ('01H00000000000000000000701','01H00000000000000000000702');
INSERT INTO semantic_internal.deletion_attestation_identity_test
VALUES ('01H00000000000000000000701','01H00000000000000000000702');
INSERT INTO semantic_internal.deletion_attestation_embedding_test
VALUES ('01H00000000000000000000701','01H00000000000000000000702');
INSERT INTO semantic_internal.deletion_attestation_cache_test
VALUES ('01H00000000000000000000701','01H00000000000000000000702');
INSERT INTO semantic_internal.deletion_attestation_other_test
VALUES ('01H00000000000000000000701','01H00000000000000000000702');
INSERT INTO mart.deletion_attestation_retained_test
VALUES ('01H00000000000000000000701');
INSERT INTO semantic_internal.connector_pack_connection_retirement(
  tenant_id,connection_id,connector_id,predecessor_pack_version,
  candidate_pack_version,retirement_reason,control_plane_audit_id,
  control_plane_evidence_sha256,retired_by
) VALUES (
  '01H00000000000000000000701','01H00000000000000000000702',
  'lightspeed-r','1.0.0','1.1.0','disconnected',
  '01H00000000000000000000703',repeat('b',64),'residual-attestation-test'
);

DO $$
DECLARE
  connection_evidence jsonb;
  tenant_evidence jsonb;
BEGIN
  connection_evidence:=deletion_internal.verify_connection_pre_capability(
    '01H00000000000000000000701','01H00000000000000000000702'
  );
  IF connection_evidence->>'measurement'<>'post_purge_row_counts_v1'
     OR (SELECT count(*) FROM jsonb_object_keys(connection_evidence))<>5
     OR (SELECT count(*) FROM jsonb_object_keys(connection_evidence->'residuals'))<>7
     OR (connection_evidence->>'verified')::boolean
     OR (connection_evidence->>'remainingRows')::bigint<>8
     OR connection_evidence->'residuals'<>jsonb_build_object(
       'stagingRows',1,
       'canonicalRows',1,
       'bridgeRows',1,
       'linkRows',1,
       'embeddingRows',1,
       'cacheRows',1,
       'otherAnalyticalRows',2
     ) THEN
    RAISE EXCEPTION 'connection residual attestation was not measured: %',
      connection_evidence;
  END IF;

  tenant_evidence:=deletion_internal.verify_tenant_pre_capability(
    '01H00000000000000000000701'
  );
  IF tenant_evidence->>'measurement'<>'post_purge_row_counts_v1'
     OR (SELECT count(*) FROM jsonb_object_keys(tenant_evidence))<>5
     OR (SELECT count(*) FROM jsonb_object_keys(tenant_evidence->'residuals'))<>7
     OR (tenant_evidence->>'verified')::boolean
     OR (tenant_evidence->>'remainingRows')::bigint<>9
     OR tenant_evidence->'residuals'<>jsonb_build_object(
       'stagingRows',1,
       'canonicalRows',1,
       'bridgeRows',2,
       'linkRows',1,
       'embeddingRows',1,
       'cacheRows',1,
       'otherAnalyticalRows',2
     ) THEN
    RAISE EXCEPTION 'tenant residual attestation was not measured: %',
      tenant_evidence;
  END IF;
END;
$$;

TRUNCATE TABLE
  ingestion.deletion_attestation_staging_test,
  core.deletion_attestation_canonical_test,
  quality.deletion_attestation_reconciliation_test,
  semantic_internal.deletion_attestation_identity_test,
  semantic_internal.deletion_attestation_embedding_test,
  semantic_internal.deletion_attestation_cache_test,
  semantic_internal.deletion_attestation_other_test,
  mart.deletion_attestation_retained_test;

SET LOCAL ROLE albert_migration_owner;
SELECT set_config('albert.deletion_authorized','on',true);
DELETE FROM semantic_internal.connector_pack_connection_retirement
 WHERE tenant_id='01H00000000000000000000701'
   AND connection_id='01H00000000000000000000702';
RESET ROLE;

DO $$
DECLARE
  connection_evidence jsonb;
  tenant_evidence jsonb;
BEGIN
  connection_evidence:=deletion_internal.verify_connection_pre_capability(
    '01H00000000000000000000701','01H00000000000000000000702'
  );
  tenant_evidence:=deletion_internal.verify_tenant_pre_capability(
    '01H00000000000000000000701'
  );
  IF coalesce((connection_evidence->>'verified')::boolean,false) IS NOT TRUE
     OR (connection_evidence->>'remainingRows')::bigint<>0
     OR coalesce((tenant_evidence->>'verified')::boolean,false) IS NOT TRUE
     OR (tenant_evidence->>'remainingRows')::bigint<>0 THEN
    RAISE EXCEPTION 'empty deletion scope did not attest cleanly: connection %, tenant %',
      connection_evidence,tenant_evidence;
  END IF;
END;
$$;

ROLLBACK;
