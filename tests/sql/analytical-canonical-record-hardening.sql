\set ON_ERROR_STOP on

BEGIN;

SET ROLE ingest_rw;
SET LOCAL albert.tenant_id = '01H00000000000000000000901';

INSERT INTO ingestion.batch_manifests (
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,
  connector_version,api_version,stream,external_account_reference,
  extracted_at,content_hash,schema_fingerprint,record_count,
  compressed_bytes,object_keys
) VALUES (
  '01H00000000000000000000901','01H00000000000000000000902',
  '01H00000000000000000000903','01H00000000000000000000904',
  'xero','1.0.0','2.0','invoices','xero-tenant-901',now(),
  repeat('a',64),repeat('b',64),1,128,
  ARRAY['tenant/901/connection/903/stream/invoices/batch-902.jsonl.gz']
);
INSERT INTO ingestion.source_records (
  tenant_id,namespaced_source_key,connection_id,external_account_reference,
  connector_key,stream,source_object_type,source_record_id,source_version,
  source_updated_at,payload_hash,normalized_schema_version,
  normalized_payload,tombstone,payload_batch_id,sync_run_id
) VALUES (
  '01H00000000000000000000901','xero:xero-tenant-901:Invoices:invoice-901',
  '01H00000000000000000000903','xero-tenant-901','xero','invoices',
  'Invoices','invoice-901','v1',now(),repeat('c',64),'1.0.0',
  '{"schemaVersion":"1.0.0","fields":{"InvoiceID":"invoice-901"}}'::jsonb,
  false,'01H00000000000000000000902','01H00000000000000000000904'
);
INSERT INTO ingestion.landing_commits (
  tenant_id,landing_commit_id,batch_id,sync_run_id,status,
  staged_record_count,quarantine_count,mapping_version
) VALUES (
  '01H00000000000000000000901','01H00000000000000000000907',
  '01H00000000000000000000902','01H00000000000000000000904',
  'committed',1,0,'canonical-v1'
);
INSERT INTO ingestion.canonical_staging_batch_records (
  tenant_id,batch_id,mapping_version,namespaced_source_key,connection_id,
  sync_run_id,connector_id,stream,source_object_type,source_record_id,
  payload_hash,staging_row
) VALUES (
  '01H00000000000000000000901','01H00000000000000000000902','canonical-v1',
  'xero:xero-tenant-901:Invoices:invoice-901','01H00000000000000000000903',
  '01H00000000000000000000904','xero','invoices','Invoices','invoice-901',
  repeat('c',64),jsonb_build_object(
    'tenant_id','01H00000000000000000000901',
    'payload_batch_id','01H00000000000000000000902',
    'mapping_version','canonical-v1',
    'namespaced_source_key','xero:xero-tenant-901:Invoices:invoice-901',
    'connection_id','01H00000000000000000000903',
    'sync_run_id','01H00000000000000000000904',
    'source_object_type','Invoices','source_record_id','invoice-901',
    'payload_hash',repeat('c',64)
  )
);

-- A later snapshot replaces the current landing seam before the old transform
-- page is claimed. Historical quarantine must remain anchored to the old
-- append-only manifest/commit rather than this newer mutable source row.
INSERT INTO ingestion.batch_manifests (
  tenant_id,batch_id,connection_id,sync_run_id,connector_key,
  connector_version,api_version,stream,external_account_reference,
  extracted_at,content_hash,schema_fingerprint,record_count,
  compressed_bytes,object_keys
) VALUES (
  '01H00000000000000000000901','01H00000000000000000000905',
  '01H00000000000000000000903','01H00000000000000000000906',
  'xero','1.0.0','2.0','invoices','xero-tenant-901',now(),
  repeat('d',64),repeat('e',64),1,128,
  ARRAY['tenant/901/connection/903/stream/invoices/batch-905.jsonl.gz']
);
UPDATE ingestion.source_records
   SET source_version='v2',payload_hash=repeat('d',64),
       payload_batch_id='01H00000000000000000000905',
       sync_run_id='01H00000000000000000000906',ingested_at=now()
 WHERE tenant_id='01H00000000000000000000901'
   AND namespaced_source_key='xero:xero-tenant-901:Invoices:invoice-901';
INSERT INTO ingestion.landing_commits (
  tenant_id,landing_commit_id,batch_id,sync_run_id,status,
  staged_record_count,quarantine_count,mapping_version
) VALUES (
  '01H00000000000000000000901','01H00000000000000000000908',
  '01H00000000000000000000905','01H00000000000000000000906',
  'committed',1,0,'canonical-v1'
);
INSERT INTO ingestion.canonical_staging_batch_records (
  tenant_id,batch_id,mapping_version,namespaced_source_key,connection_id,
  sync_run_id,connector_id,stream,source_object_type,source_record_id,
  payload_hash,staging_row
) VALUES (
  '01H00000000000000000000901','01H00000000000000000000905','canonical-v1',
  'xero:xero-tenant-901:Invoices:invoice-901','01H00000000000000000000903',
  '01H00000000000000000000906','xero','invoices','Invoices','invoice-901',
  repeat('d',64),jsonb_build_object(
    'tenant_id','01H00000000000000000000901',
    'payload_batch_id','01H00000000000000000000905',
    'mapping_version','canonical-v1',
    'namespaced_source_key','xero:xero-tenant-901:Invoices:invoice-901',
    'connection_id','01H00000000000000000000903',
    'sync_run_id','01H00000000000000000000906',
    'source_object_type','Invoices','source_record_id','invoice-901',
    'payload_hash',repeat('d',64)
  )
);

RESET ROLE;
SET ROLE transform_rw;
SET LOCAL albert.tenant_id = '01H00000000000000000000901';

SELECT semantic_internal.record_canonical_mapping_quarantine(
  '01H00000000000000000000901','01H00000000000000000000903',
  '01H00000000000000000000904','01H00000000000000000000902',
  'invoices','Invoices','invoice-901',repeat('c',64),'canonical-v1',
  'canonical.xero_canonical_date_missing','$mapper',
  'Canonical mapper rejected this typed source record (xero_canonical_date_missing).'
);
SELECT quality.record_canonical_mapping_quality(
  '01H00000000000000000000901','01H00000000000000000000904',2,1
);

DO $$
DECLARE open_count integer;mapping_status text;
BEGIN
  SELECT count(*) INTO open_count
    FROM ingestion.quarantine_records
   WHERE tenant_id='01H00000000000000000000901'
     AND source_record_id='invoice-901'
     AND error_code='canonical.xero_canonical_date_missing'
     AND status='open';
  SELECT status INTO mapping_status
    FROM quality.check_result
   WHERE tenant_id='01H00000000000000000000901'
     AND run_id='01H00000000000000000000904'
     AND check_id='canonical_mapping_total';
  IF open_count<>1 OR mapping_status<>'warning' THEN
    RAISE EXCEPTION 'canonical quarantine was not durable: open %, quality %',
      open_count,mapping_status;
  END IF;
END $$;

DO $$
DECLARE resolved bigint;
BEGIN
  SELECT semantic_internal.resolve_canonical_mapping_quarantine(
    '01H00000000000000000000901','01H00000000000000000000903',
    '01H00000000000000000000906','01H00000000000000000000905',
    'invoices','Invoices','invoice-901',repeat('d',64)
  ) INTO resolved;
  IF resolved<>1 THEN
    RAISE EXCEPTION 'expected one healed canonical quarantine, found %',resolved;
  END IF;
END $$;
SELECT quality.record_canonical_mapping_quality(
  '01H00000000000000000000901','01H00000000000000000000904',1,0
);

DO $$
DECLARE resolved_count integer;mapping_status text;
BEGIN
  SELECT count(*) INTO resolved_count
    FROM ingestion.quarantine_records
   WHERE tenant_id='01H00000000000000000000901'
     AND source_record_id='invoice-901'
     AND status='resolved'
     AND resolution_reason='canonical_projection_recovered'
     AND replayed_in_sync_run_id='01H00000000000000000000906';
  SELECT status INTO mapping_status
    FROM quality.check_result
   WHERE tenant_id='01H00000000000000000000901'
     AND run_id='01H00000000000000000000904'
     AND check_id='canonical_mapping_total';
  IF resolved_count<>1 OR mapping_status<>'passed' THEN
    RAISE EXCEPTION 'canonical replay did not heal quality: resolved %, quality %',
      resolved_count,mapping_status;
  END IF;
END $$;

INSERT INTO core.person(tenant_id,id,display_name,sync_run_id) VALUES (
  '01H00000000000000000000901','01H00000000000000000000910',
  'Episode Test','01H00000000000000000000914'
);
INSERT INTO core.worker(tenant_id,id,person_id,display_name,active,sync_run_id) VALUES (
  '01H00000000000000000000901','01H00000000000000000000911',
  '01H00000000000000000000910','Episode Test',true,
  '01H00000000000000000000914'
);
INSERT INTO core.employment_episode(
  tenant_id,id,worker_id,effective_from,effective_to,status,sync_run_id
) VALUES (
  '01H00000000000000000000901','01H00000000000000000000912',
  '01H00000000000000000000911','2020-01-01',NULL,'active',
  '01H00000000000000000000914'
);
INSERT INTO core.employment_episode(
  tenant_id,id,worker_id,effective_from,effective_to,status,sync_run_id
) VALUES (
  '01H00000000000000000000901','01H00000000000000000000913',
  '01H00000000000000000000911','2026-07-01',NULL,'active',
  '01H00000000000000000000915'
);

DO $$
DECLARE episode_count integer;prior_end date;prior_status text;rehire_status text;
BEGIN
  SELECT count(*) INTO episode_count
    FROM core.employment_episode
   WHERE tenant_id='01H00000000000000000000901'
     AND worker_id='01H00000000000000000000911';
  SELECT effective_to,status INTO prior_end,prior_status
    FROM core.employment_episode
   WHERE tenant_id='01H00000000000000000000901'
     AND id='01H00000000000000000000912';
  SELECT status INTO rehire_status
    FROM core.employment_episode
   WHERE tenant_id='01H00000000000000000000901'
     AND id='01H00000000000000000000913';
  IF episode_count<>2 OR prior_end<>'2026-07-01'::date
     OR prior_status<>'terminated' OR rehire_status<>'active' THEN
    RAISE EXCEPTION 'rehire interval history is invalid: count %, prior %/%, rehire %',
      episode_count,prior_end,prior_status,rehire_status;
  END IF;
END $$;

RESET ROLE;
DO $$
DECLARE missing_helpers text;
BEGIN
  IF NOT has_function_privilege(
       'transform_rw',
       'semantic_internal.record_canonical_mapping_quarantine(text,text,text,text,text,text,text,text,text,text,text,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'ingest_rw',
       'semantic_internal.record_canonical_mapping_quarantine(text,text,text,text,text,text,text,text,text,text,text,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'public',
       'semantic_internal.resolve_canonical_mapping_quarantine(text,text,text,text,text,text,text,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'canonical quarantine function ACL is not transform-only';
  END IF;

  SELECT string_agg(format('%I.%I',helper.schema_name,helper.function_name),', ')
    INTO missing_helpers
    FROM (
      SELECT DISTINCT matches[1] AS schema_name,matches[2] AS function_name
        FROM pg_constraint constraint_row
        JOIN pg_class relation ON relation.oid=constraint_row.conrelid
        JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        CROSS JOIN LATERAL regexp_matches(
          pg_get_constraintdef(constraint_row.oid),
          '([a-z_]+)\.([a-z_]+)\(',
          'g'
        ) matches
       WHERE constraint_row.contype='c'
         AND namespace.nspname IN ('core','mart','quality','semantic_internal')
         AND has_table_privilege('transform_rw',relation.oid,'INSERT')
    ) helper
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_proc procedure
       JOIN pg_namespace procedure_namespace
         ON procedure_namespace.oid=procedure.pronamespace
      WHERE procedure_namespace.nspname=helper.schema_name
        AND procedure.proname=helper.function_name
        AND has_function_privilege('transform_rw',procedure.oid,'EXECUTE')
   );
  IF missing_helpers IS NOT NULL THEN
    RAISE EXCEPTION 'transform CHECK helpers lack EXECUTE: %',missing_helpers;
  END IF;
END $$;

ROLLBACK;
