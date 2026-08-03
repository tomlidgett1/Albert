BEGIN;

INSERT INTO ingestion.quarantine_status_lookup(status,description)
VALUES ('resolved','A corrected replay committed and healed this quarantine finding')
ON CONFLICT (status) DO UPDATE SET description=excluded.description;

-- A transform batch is allowed to make progress when one typed source row
-- cannot be projected. The rejected source identity remains attached to its
-- immutable raw batch and is only healed after a later canonical projection
-- of that exact identity commits successfully.
ALTER TABLE semantic_internal.canonical_transform_commits
  ADD COLUMN IF NOT EXISTS quarantined_rows bigint NOT NULL DEFAULT 0
    CHECK (quarantined_rows>=0);

CREATE INDEX IF NOT EXISTS quarantine_records_open_canonical_identity_idx
  ON ingestion.quarantine_records(
    tenant_id,connection_id,stream,source_object_type,source_record_id
  )
  WHERE status='open'
    AND source_record_id IS NOT NULL
    AND error_code LIKE 'canonical.%';

CREATE OR REPLACE FUNCTION semantic_internal.record_canonical_mapping_quarantine(
  p_tenant_id text,
  p_connection_id text,
  p_sync_run_id text,
  p_batch_id text,
  p_stream text,
  p_source_object_type text,
  p_source_record_id text,
  p_payload_hash text,
  p_mapping_version text,
  p_error_code text,
  p_error_path text,
  p_error_summary text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,ingestion,semantic_internal
AS $$
DECLARE
  raw_object_key text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT core.is_ulid(p_tenant_id)
     OR NOT core.is_ulid(p_connection_id)
     OR NOT core.is_ulid(p_sync_run_id)
     OR NOT core.is_ulid(p_batch_id) THEN
    RAISE EXCEPTION 'canonical quarantine lineage is invalid' USING ERRCODE='22023';
  END IF;
  IF p_stream !~ '^[a-z][a-z0-9_]{0,99}$'
     OR length(btrim(p_source_object_type)) NOT BETWEEN 1 AND 200
     OR length(btrim(p_source_record_id)) NOT BETWEEN 1 AND 300
     OR p_payload_hash !~ '^[a-f0-9]{64}$'
     OR length(btrim(p_mapping_version)) NOT BETWEEN 1 AND 100
     OR p_error_code !~ '^canonical\.[a-z][a-z0-9_.-]{0,119}$'
     OR p_error_path NOT IN ('$mapper','$projection')
     OR length(btrim(p_error_summary)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'canonical quarantine evidence is invalid' USING ERRCODE='22023';
  END IF;

  SELECT manifest.object_keys[1]
    INTO raw_object_key
    FROM ingestion.batch_manifests manifest
    JOIN ingestion.source_records source
      ON source.tenant_id=manifest.tenant_id
     AND source.payload_batch_id=manifest.batch_id
     AND source.connection_id=manifest.connection_id
     AND source.sync_run_id=manifest.sync_run_id
   WHERE manifest.tenant_id=p_tenant_id
     AND manifest.batch_id=p_batch_id
     AND manifest.connection_id=p_connection_id
     AND manifest.sync_run_id=p_sync_run_id
     AND manifest.stream=p_stream
     AND source.source_object_type=p_source_object_type
     AND source.source_record_id=p_source_record_id
     AND source.payload_hash=p_payload_hash;
  IF raw_object_key IS NULL THEN
    RAISE EXCEPTION 'canonical quarantine source lineage is missing'
      USING ERRCODE='23503';
  END IF;

  INSERT INTO ingestion.quarantine_records (
    tenant_id,quarantine_id,connection_id,sync_run_id,payload_batch_id,
    stream,source_object_type,source_record_id,payload_hash,raw_object_key,
    error_code,error_path,error_summary,mapping_version,status
  ) VALUES (
    p_tenant_id,
    semantic_internal.deterministic_ulid(
      'canonical-quarantine-v1|'||p_tenant_id||'|'||p_batch_id||'|'||
      p_source_object_type||'|'||p_source_record_id||'|'||p_error_code||'|'||p_error_path
    ),
    p_connection_id,p_sync_run_id,p_batch_id,p_stream,p_source_object_type,
    p_source_record_id,p_payload_hash,raw_object_key,p_error_code,p_error_path,
    p_error_summary,p_mapping_version,'open'
  )
  ON CONFLICT (
    tenant_id,payload_batch_id,source_object_type,source_record_id,error_code,error_path
  ) DO UPDATE SET
    connection_id=excluded.connection_id,
    sync_run_id=excluded.sync_run_id,
    payload_hash=excluded.payload_hash,
    raw_object_key=excluded.raw_object_key,
    error_summary=excluded.error_summary,
    mapping_version=excluded.mapping_version,
    status='open',
    replayed_in_sync_run_id=NULL,
    resolution_reason=NULL,
    resolved_at=NULL;
END $$;

CREATE OR REPLACE FUNCTION semantic_internal.resolve_canonical_mapping_quarantine(
  p_tenant_id text,
  p_connection_id text,
  p_sync_run_id text,
  p_batch_id text,
  p_stream text,
  p_source_object_type text,
  p_source_record_id text,
  p_payload_hash text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,ingestion
AS $$
DECLARE
  resolved_count bigint:=0;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM ingestion.batch_manifests manifest
      JOIN ingestion.source_records source
        ON source.tenant_id=manifest.tenant_id
       AND source.payload_batch_id=manifest.batch_id
       AND source.connection_id=manifest.connection_id
       AND source.sync_run_id=manifest.sync_run_id
     WHERE manifest.tenant_id=p_tenant_id
       AND manifest.batch_id=p_batch_id
       AND manifest.connection_id=p_connection_id
       AND manifest.sync_run_id=p_sync_run_id
       AND manifest.stream=p_stream
       AND source.source_object_type=p_source_object_type
       AND source.source_record_id=p_source_record_id
       AND source.payload_hash=p_payload_hash
  ) THEN
    RAISE EXCEPTION 'canonical quarantine recovery lineage is missing'
      USING ERRCODE='23503';
  END IF;

  UPDATE ingestion.quarantine_records quarantine
     SET status='resolved',
         replayed_in_sync_run_id=p_sync_run_id,
         resolution_reason='canonical_projection_recovered',
         resolved_at=now()
   WHERE quarantine.tenant_id=p_tenant_id
     AND quarantine.connection_id=p_connection_id
     AND quarantine.stream=p_stream
     AND quarantine.source_object_type=p_source_object_type
     AND quarantine.source_record_id=p_source_record_id
     AND quarantine.status='open'
     AND quarantine.error_code LIKE 'canonical.%';
  GET DIAGNOSTICS resolved_count=ROW_COUNT;
  RETURN resolved_count;
END $$;

INSERT INTO quality.check_expectation (
  check_id,domain,description,max_age,required,blocks_readiness
) VALUES (
  'canonical_mapping_total','canonical',
  'Every typed source record either maps to canonical truth or remains in an explicit recoverable quarantine.',
  interval '26 hours',true,true
)
ON CONFLICT (check_id) DO UPDATE SET
  domain=excluded.domain,
  description=excluded.description,
  max_age=excluded.max_age,
  required=excluded.required,
  blocks_readiness=excluded.blocks_readiness;

CREATE OR REPLACE FUNCTION quality.record_canonical_mapping_quality(
  p_tenant_id text,
  p_run_id text,
  p_staged_rows bigint,
  p_rejected_rows bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,ingestion,quality
AS $$
DECLARE
  open_count bigint:=0;
  outcome text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT core.is_ulid(p_run_id)
     OR p_staged_rows<0
     OR p_rejected_rows<0
     OR p_rejected_rows>p_staged_rows THEN
    RAISE EXCEPTION 'canonical mapping quality evidence is invalid'
      USING ERRCODE='22023';
  END IF;

  SELECT count(*) INTO open_count
    FROM ingestion.quarantine_records quarantine
   WHERE quarantine.tenant_id=p_tenant_id
     AND quarantine.status='open'
     AND quarantine.error_code LIKE 'canonical.%';
  outcome:=CASE
    WHEN open_count=0 THEN 'passed'
    WHEN p_staged_rows>0 AND p_rejected_rows=p_staged_rows THEN 'blocked'
    ELSE 'warning'
  END;
  PERFORM quality.record_check(
    p_tenant_id,p_run_id,'canonical_mapping_total','canonical',outcome,
    open_count,0,
    jsonb_build_object(
      'measurement','open_canonical_mapping_quarantine',
      'staged_rows',p_staged_rows,
      'rejected_rows',p_rejected_rows,
      'open_records',open_count
    )
  );
END $$;

-- Employment episodes are one continuous interval, not one mutable employee.
-- A later start closes an earlier open interval, and an out-of-order earlier
-- interval is bounded by the next known start. This trigger is source-neutral;
-- connector packs still decide which source fields define an episode.
CREATE OR REPLACE FUNCTION core.normalize_employment_episode_interval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,core
AS $$
DECLARE
  next_effective_from date;
BEGIN
  IF pg_trigger_depth()>1 THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;

  SELECT min(episode.effective_from)
    INTO next_effective_from
    FROM core.employment_episode episode
   WHERE episode.tenant_id=NEW.tenant_id
     AND episode.worker_id=NEW.worker_id
     AND episode.id<>NEW.id
     AND episode.effective_from>NEW.effective_from;
  IF next_effective_from IS NOT NULL
     AND (NEW.effective_to IS NULL OR NEW.effective_to>next_effective_from) THEN
    NEW.effective_to:=next_effective_from;
    NEW.status:='terminated';
  END IF;

  UPDATE core.employment_episode episode
     SET effective_to=NEW.effective_from,
         status='terminated',
         updated_at=now()
   WHERE episode.tenant_id=NEW.tenant_id
     AND episode.worker_id=NEW.worker_id
     AND episode.id<>NEW.id
     AND episode.effective_from<NEW.effective_from
     AND (episode.effective_to IS NULL OR episode.effective_to>NEW.effective_from);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS normalize_employment_episode_interval
  ON core.employment_episode;
CREATE TRIGGER normalize_employment_episode_interval
  BEFORE INSERT OR UPDATE OF worker_id,effective_from,effective_to,status
  ON core.employment_episode
  FOR EACH ROW EXECUTE FUNCTION core.normalize_employment_episode_interval();

CREATE UNIQUE INDEX IF NOT EXISTS employment_episode_worker_start_uidx
  ON core.employment_episode(tenant_id,worker_id,effective_from);
CREATE INDEX IF NOT EXISTS employment_episode_worker_interval_idx
  ON core.employment_episode(tenant_id,worker_id,effective_from,effective_to);

REVOKE ALL ON FUNCTION
  semantic_internal.record_canonical_mapping_quarantine(
    text,text,text,text,text,text,text,text,text,text,text,text
  ),
  semantic_internal.resolve_canonical_mapping_quarantine(
    text,text,text,text,text,text,text,text
  ),
  quality.record_canonical_mapping_quality(text,text,bigint,bigint),
  core.normalize_employment_episode_interval()
FROM PUBLIC;
-- These two immutable validators are invoked by canonical CHECK constraints.
-- Migration 0082 removed PUBLIC execution correctly, but transform_rw must be
-- able to execute the validators in order to perform its declared core writes.
GRANT EXECUTE ON FUNCTION
  core.is_ulid(text),
  core.is_currency(text),
  semantic_internal.record_canonical_mapping_quarantine(
    text,text,text,text,text,text,text,text,text,text,text,text
  ),
  semantic_internal.resolve_canonical_mapping_quarantine(
    text,text,text,text,text,text,text,text
  ),
  quality.record_canonical_mapping_quality(text,text,bigint,bigint)
TO transform_rw;

COMMIT;
