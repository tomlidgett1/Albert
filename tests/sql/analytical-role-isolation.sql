\set ON_ERROR_STOP on

SET ROLE transform_rw;
BEGIN;
SET LOCAL albert.tenant_id = '01H00000000000000000000001';
INSERT INTO core.product (tenant_id, id, name, sync_run_id)
VALUES (
  '01H00000000000000000000001', '01H00000000000000000000011',
  'Tenant one product', '01H00000000000000000000031'
);
COMMIT;

BEGIN;
SET LOCAL albert.tenant_id = '01H00000000000000000000002';
INSERT INTO core.product (tenant_id, id, name, sync_run_id)
VALUES (
  '01H00000000000000000000002', '01H00000000000000000000012',
  'Tenant two product', '01H00000000000000000000032'
);
COMMIT;

BEGIN;
SET LOCAL albert.tenant_id = '01H00000000000000000000001';
DO $$
BEGIN
  INSERT INTO core.product (tenant_id, id, name, sync_run_id)
  VALUES (
    '01H00000000000000000000002', '01H00000000000000000000013',
    'Forbidden product', '01H00000000000000000000033'
  );
  RAISE EXCEPTION 'cross-tenant transform insert unexpectedly succeeded';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$$;
COMMIT;

RESET ROLE;
SET ROLE semantic_ro;
BEGIN;
SET LOCAL albert.tenant_id = '01H00000000000000000000001';
DO $$
DECLARE
  visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM core.product;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'semantic tenant isolation failed: expected 1 row, found %', visible_count;
  END IF;
  BEGIN
    INSERT INTO core.product (tenant_id, id, name, sync_run_id)
    VALUES (
      '01H00000000000000000000001', '01H00000000000000000000014',
      'Forbidden write', '01H00000000000000000000034'
    );
    RAISE EXCEPTION 'semantic role unexpectedly wrote canonical data';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
COMMIT;

RESET ROLE;
SET ROLE ingest_rw;
BEGIN;
SET LOCAL albert.tenant_id = '01H00000000000000000000001';
INSERT INTO ingestion.batch_manifests (
  tenant_id, batch_id, connection_id, sync_run_id, connector_key,
  connector_version, api_version, stream, external_account_reference,
  extracted_at, content_hash, schema_fingerprint, record_count,
  compressed_bytes, object_keys
) VALUES (
  '01H00000000000000000000001', '01H00000000000000000000021',
  '01H00000000000000000000022', '01H00000000000000000000023',
  'lightspeed-r', '1.0.0', '2026-08', 'shops', 'shop-1', now(),
  repeat('0', 64), repeat('1', 64), 1, 128,
  ARRAY['tenant/01H00000000000000000000001/batch.jsonl.gz']
);
DO $$
BEGIN
  UPDATE ingestion.batch_manifests
  SET record_count = 2
  WHERE tenant_id = '01H00000000000000000000001';
  RAISE EXCEPTION 'immutable batch manifest unexpectedly changed';
EXCEPTION WHEN insufficient_privilege OR object_not_in_prerequisite_state THEN
  NULL;
END;
$$;
DO $$
BEGIN
  INSERT INTO core.product (tenant_id, id, name, sync_run_id)
  VALUES (
    '01H00000000000000000000001', '01H00000000000000000000015',
    'Parser escape', '01H00000000000000000000035'
  );
  RAISE EXCEPTION 'ingest role unexpectedly wrote canonical data';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$$;
COMMIT;

RESET ROLE;
