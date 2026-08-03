\set ON_ERROR_STOP on

BEGIN;

SET LOCAL ROLE transform_rw;
SET LOCAL albert.tenant_id='01J00000000000000000000301';

INSERT INTO core.legal_entity(
  tenant_id,id,name,base_currency,active,sync_run_id
) VALUES
  ('01J00000000000000000000301','01J00000000000000000000311','Xero AU entity','AUD',true,'01J00000000000000000000341'),
  ('01J00000000000000000000301','01J00000000000000000000312','Xero NZ entity','NZD',true,'01J00000000000000000000342');

INSERT INTO core.gl_account(
  tenant_id,id,legal_entity_id,code,name,account_class,active,sync_run_id
) VALUES
  ('01J00000000000000000000301','01J00000000000000000000321','01J00000000000000000000311','200','AU revenue','income',true,'01J00000000000000000000341'),
  ('01J00000000000000000000301','01J00000000000000000000322','01J00000000000000000000312','200','NZ revenue','income',true,'01J00000000000000000000342');

INSERT INTO semantic_internal.canonical_record_state(
  tenant_id,canonical_table,canonical_id,source_updated_at,source_version,
  payload_hash,batch_id,sync_run_id,connection_id,source_object_type,
  source_record_id,mapping_version
) VALUES
  ('01J00000000000000000000301','legal_entity','01J00000000000000000000311',
   '2026-07-01T00:00:00Z','1',repeat('a',64),'01J00000000000000000000351',
   '01J00000000000000000000341','01J00000000000000000000331','Organisation','org-au','v1'),
  ('01J00000000000000000000301','legal_entity','01J00000000000000000000312',
   '2026-07-01T00:00:00Z','1',repeat('b',64),'01J00000000000000000000352',
   '01J00000000000000000000342','01J00000000000000000000332','Organisation','org-nz','v1');

SELECT core.install_default_source_authority(
  '01J00000000000000000000301','statutory_finance','legal_entity',
  '01J00000000000000000000311','01J00000000000000000000331',
  '01J00000000000000000000341','1970-01-01T00:00:00Z'
);
SELECT core.install_default_source_authority(
  '01J00000000000000000000301','statutory_finance','legal_entity',
  '01J00000000000000000000312','01J00000000000000000000332',
  '01J00000000000000000000342','1970-01-01T00:00:00Z'
);

DO $$
BEGIN
  IF NOT core.source_is_authoritative(
       '01J00000000000000000000301','statutory_finance','legal_entity',
       '01J00000000000000000000311','01J00000000000000000000331',
       '2026-07-15T00:00:00Z'
     ) OR NOT core.source_is_authoritative(
       '01J00000000000000000000301','statutory_finance','legal_entity',
       '01J00000000000000000000312','01J00000000000000000000332',
       '2026-07-15T00:00:00Z'
     ) THEN
    RAISE EXCEPTION 'two Xero organisations did not retain independent authority';
  END IF;

  BEGIN
    PERFORM core.install_default_source_authority(
      '01J00000000000000000000301','statutory_finance','legal_entity',
      '01J00000000000000000000311','01J00000000000000000000332',
      '01J00000000000000000000342','1970-01-01T00:00:00Z'
    );
    RAISE EXCEPTION 'Xero NZ claimed the Xero AU legal entity';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'connection does not own canonical authority scope%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM core.assert_source_authority(
      '01J00000000000000000000301','statutory_finance','legal_entity',
      '01J00000000000000000000311','01J00000000000000000000332',
      '2026-07-15T00:00:00Z'
    );
    RAISE EXCEPTION 'Xero NZ was authoritative for the Xero AU legal entity';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'canonical_non_authoritative:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO core.source_authority(
      tenant_id,id,concept,scope_type,scope_id,authoritative_connection_id,
      effective_from,effective_to,sync_run_id
    ) VALUES (
      '01J00000000000000000000301','01J00000000000000000000361',
      'statutory_finance','legal_entity','01J00000000000000000000311',
      '01J00000000000000000000331','2026-01-01T00:00:00Z',
      '2026-02-01T00:00:00Z','01J00000000000000000000341'
    );
    RAISE EXCEPTION 'overlapping effective authority interval was accepted';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
END;
$$;

INSERT INTO core.finance_journal_line(
  tenant_id,id,journal_id,line_number,legal_entity_id,gl_account_id,
  posted_at,business_date,status,debit_amount,credit_amount,tax_amount,currency,
  primary_connection_id,primary_source_record_id,sync_run_id,source_updated_at
) VALUES
  ('01J00000000000000000000301','01J00000000000000000000371','journal-au',1,
   '01J00000000000000000000311','01J00000000000000000000321',
   '2026-07-15T00:00:00Z','2026-07-15','posted',100,0,0,'AUD',
   '01J00000000000000000000331','journal-au-1','01J00000000000000000000341','2026-07-15T00:00:00Z'),
  ('01J00000000000000000000301','01J00000000000000000000372','journal-nz',1,
   '01J00000000000000000000312','01J00000000000000000000322',
   '2026-07-15T00:00:00Z','2026-07-15','posted',200,0,0,'NZD',
   '01J00000000000000000000332','journal-nz-1','01J00000000000000000000342','2026-07-15T00:00:00Z');

DO $$
DECLARE aggregate_debit numeric;
DECLARE contributor_count integer;
BEGIN
  SELECT sum(debit_amount),count(DISTINCT primary_connection_id)
    INTO aggregate_debit,contributor_count
    FROM core.finance_journal_line
   WHERE tenant_id='01J00000000000000000000301'
     AND business_date='2026-07-15';
  IF aggregate_debit<>300 OR contributor_count<>2 THEN
    RAISE EXCEPTION 'two-organisation finance aggregate/provenance was incomplete: %, %',
      aggregate_debit,contributor_count;
  END IF;
END;
$$;

RESET ROLE;
ROLLBACK;
