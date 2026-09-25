BEGIN;

-- Shopify requires customers/data_request and customers/redact to be acted on
-- within 30 days. Receipt is not completion. Official contract (2026-07):
-- https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
--
-- Raw Shopify objects are immutable connection/batch-grain JSONL. A truthful
-- customer-only erase cannot remove one customer from those objects. Redaction
-- therefore uses Albert's verified full-connection deletion primitive. This is
-- intentionally conservative: credentials, raw objects, typed staging,
-- canonical data, derived artefacts and control-plane state are all removed.

ALTER TABLE control_plane.shopify_compliance_inbox
  ADD COLUMN IF NOT EXISTS redacted_at timestamptz;
ALTER TABLE control_plane.shopify_compliance_inbox
  DROP CONSTRAINT IF EXISTS shopify_compliance_inbox_topic_payload_check;
ALTER TABLE control_plane.shopify_compliance_inbox
  ADD CONSTRAINT shopify_compliance_inbox_topic_payload_check CHECK (
    (
      topic='customers/data_request'
      AND redacted_at IS NULL
      AND data_request_reference IS NOT NULL
      AND (customer_reference IS NOT NULL OR customer_contact_hmac IS NOT NULL)
    ) OR (
      topic='customers/redact'
      AND data_request_reference IS NULL
      AND (
        (redacted_at IS NULL
          AND (customer_reference IS NOT NULL OR customer_contact_hmac IS NOT NULL))
        OR
        (redacted_at IS NOT NULL
          AND customer_reference IS NULL
          AND customer_contact_hmac IS NULL
          AND cardinality(order_references)=0)
      )
    ) OR (
      topic IN ('shop/redact','app/uninstalled')
      AND redacted_at IS NULL
      AND customer_reference IS NULL
      AND customer_contact_hmac IS NULL
      AND cardinality(order_references)=0
      AND data_request_reference IS NULL
    )
  );

-- Customer privacy cases and one-use export grants are separate state
-- machines. Dedicated catalogues keep each legal transition surface exact;
-- overlapping labels such as completed do not make the lifecycles
-- interchangeable.
CREATE TABLE control_plane.shopify_privacy_case_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.shopify_privacy_case_status_lookup (
  status,description
) VALUES
  ('queued','The attested privacy obligation is ready for the privacy consumer'),
  ('redaction_dispatched','A generation-bound verified deletion request exists for the redaction case'),
  ('awaiting_operator_export','A data request is ready for an authorized operator to request an export'),
  ('export_in_progress','A one-use export grant exists or an authorized exporter owns it'),
  ('awaiting_delivery','The export artifact is complete and awaits explicit secure-delivery evidence'),
  ('attention_required','The obligation requires operator resolution and remains incomplete'),
  ('completed','Verified erasure or explicit secure-delivery evidence completed the obligation');

CREATE TABLE control_plane.shopify_privacy_export_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.shopify_privacy_export_status_lookup (
  status,description
) VALUES
  ('requested','An authorized one-use export grant is available to claim'),
  ('claimed','The diagnostic exporter owns the still-valid one-use grant'),
  ('completed','The bounded export artifact and its digest were produced successfully'),
  ('failed','The export attempt terminated with a code-only failure'),
  ('expired','The one-use export grant expired before successful completion');

CREATE TABLE control_plane.shopify_privacy_cases (
  case_id text PRIMARY KEY CHECK (control_plane.is_ulid(case_id)),
  inbox_id text NOT NULL
    REFERENCES control_plane.shopify_compliance_inbox(inbox_id) ON DELETE RESTRICT,
  target_tenant_id text NOT NULL,
  target_connection_id text NOT NULL,
  target_connection_generation bigint NOT NULL CHECK (target_connection_generation>0),
  topic text NOT NULL CHECK (topic IN ('customers/data_request','customers/redact')),
  status text NOT NULL
    REFERENCES control_plane.shopify_privacy_case_status_lookup(status),
  customer_reference text CHECK (
    customer_reference IS NULL OR customer_reference ~ '^(0|[1-9][0-9]{0,29})$'
  ),
  customer_contact_hmac text CHECK (
    customer_contact_hmac IS NULL OR customer_contact_hmac ~ '^[0-9a-f]{64}$'
  ),
  order_references text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (cardinality(order_references)<=5000),
  data_request_reference text CHECK (
    data_request_reference IS NULL OR
    data_request_reference ~ '^(0|[1-9][0-9]{0,29})$'
  ),
  deletion_request_id text,
  received_at timestamptz NOT NULL,
  complete_by timestamptz NOT NULL,
  overdue_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,79}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (inbox_id,target_tenant_id,target_connection_id,target_connection_generation),
  FOREIGN KEY (target_tenant_id,target_connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_tenant_id,deletion_request_id)
    REFERENCES control_plane.deletion_requests(tenant_id,deletion_request_id) ON DELETE RESTRICT,
  CHECK (complete_by=received_at+interval '30 days'),
  CHECK (completed_at IS NULL OR status='completed'),
  CHECK (
    (topic='customers/redact' AND data_request_reference IS NULL)
    OR (topic='customers/data_request' AND (
      data_request_reference IS NOT NULL OR status='completed'
    ))
  ),
  CHECK (
    status='completed'
    OR customer_reference IS NOT NULL
    OR customer_contact_hmac IS NOT NULL
  )
);

CREATE INDEX shopify_privacy_cases_sla_idx
  ON control_plane.shopify_privacy_cases (status,complete_by)
  WHERE status<>'completed';
CREATE INDEX shopify_privacy_cases_deletion_idx
  ON control_plane.shopify_privacy_cases (target_tenant_id,deletion_request_id)
  WHERE deletion_request_id IS NOT NULL;

CREATE TABLE control_plane.shopify_privacy_job_attempts (
  inbox_id text NOT NULL
    REFERENCES control_plane.shopify_compliance_inbox(inbox_id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number>0),
  worker_id text NOT NULL CHECK (length(btrim(worker_id)) BETWEEN 1 AND 160),
  message_id bigint NOT NULL,
  visibility_deadline timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('succeeded','retry','failed')),
  error_metadata jsonb CHECK (
    error_metadata IS NULL OR jsonb_typeof(error_metadata)='object'
  ),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (inbox_id,attempt_number),
  CHECK (
    (outcome IS NULL AND finished_at IS NULL)
    OR (outcome IS NOT NULL AND finished_at IS NOT NULL)
  )
);

CREATE TABLE control_plane.shopify_privacy_exports (
  export_id text PRIMARY KEY CHECK (control_plane.is_ulid(export_id)),
  case_id text NOT NULL
    REFERENCES control_plane.shopify_privacy_cases(case_id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  status text NOT NULL
    REFERENCES control_plane.shopify_privacy_export_status_lookup(status),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  completed_at timestamptz,
  artifact_sha256 text CHECK (
    artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$'
  ),
  record_count integer CHECK (record_count IS NULL OR record_count>=0),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  CHECK (expires_at>requested_at AND expires_at<=requested_at+interval '10 minutes'),
  CHECK (
    (status='requested' AND claimed_at IS NULL AND completed_at IS NULL)
    OR (status='claimed' AND claimed_at IS NOT NULL AND completed_at IS NULL)
    OR (status='completed' AND claimed_at IS NOT NULL AND completed_at IS NOT NULL
        AND artifact_sha256 IS NOT NULL AND record_count IS NOT NULL AND error_code IS NULL)
    OR (status='failed' AND claimed_at IS NOT NULL AND completed_at IS NOT NULL
        AND artifact_sha256 IS NULL AND record_count IS NULL AND error_code IS NOT NULL)
    OR (status='expired' AND completed_at IS NOT NULL
        AND artifact_sha256 IS NULL AND record_count IS NULL
        AND error_code='EXPORT_GRANT_EXPIRED')
  )
);

CREATE UNIQUE INDEX shopify_privacy_one_live_export
  ON control_plane.shopify_privacy_exports (case_id)
  WHERE status IN ('requested','claimed');

CREATE TABLE control_plane.shopify_privacy_delivery_evidence (
  case_id text PRIMARY KEY
    REFERENCES control_plane.shopify_privacy_cases(case_id) ON DELETE CASCADE,
  export_id text NOT NULL UNIQUE
    REFERENCES control_plane.shopify_privacy_exports(export_id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  record_count integer NOT NULL CHECK (record_count>=0),
  delivery_channel text NOT NULL CHECK (
    delivery_channel IN ('direct_to_shop_owner','approved_secure_portal')
  ),
  delivered_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE control_plane.shopify_privacy_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopify_privacy_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopify_privacy_job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopify_privacy_job_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopify_privacy_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopify_privacy_exports FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopify_privacy_delivery_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopify_privacy_delivery_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY migration_owner_shopify_privacy_cases
  ON control_plane.shopify_privacy_cases FOR ALL TO albert_control_migration_owner
  USING (true) WITH CHECK (true);
CREATE POLICY migration_owner_shopify_privacy_attempts
  ON control_plane.shopify_privacy_job_attempts FOR ALL TO albert_control_migration_owner
  USING (true) WITH CHECK (true);
CREATE POLICY migration_owner_shopify_privacy_exports
  ON control_plane.shopify_privacy_exports FOR ALL TO albert_control_migration_owner
  USING (true) WITH CHECK (true);
CREATE POLICY migration_owner_shopify_privacy_delivery
  ON control_plane.shopify_privacy_delivery_evidence FOR ALL TO albert_control_migration_owner
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION control_plane.touch_shopify_privacy_case()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER shopify_privacy_cases_touch
  BEFORE UPDATE ON control_plane.shopify_privacy_cases
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_shopify_privacy_case();

CREATE OR REPLACE FUNCTION control_plane.reject_shopify_privacy_delivery_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Shopify privacy delivery evidence is append-only'
    USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER shopify_privacy_delivery_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.shopify_privacy_delivery_evidence
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_shopify_privacy_delivery_mutation();

CREATE OR REPLACE FUNCTION control_plane.assert_shopify_privacy_queue_ready()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pgmq AS $$
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_deletion_control_runtime','albert_deletion_control'
  );
  IF to_regclass('control_plane.shopify_privacy_cases') IS NULL
     OR to_regclass('control_plane.shopify_privacy_job_attempts') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pgmq.meta WHERE queue_name='albert_shopify_privacy'
     ) THEN
    RAISE EXCEPTION 'Shopify privacy consumer is not ready' USING ERRCODE='55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.claim_shopify_privacy_jobs(
  p_worker_id text,p_visibility_timeout_seconds integer DEFAULT 900,
  p_quantity integer DEFAULT 1
) RETURNS TABLE (
  message_id bigint,read_count bigint,visibility_deadline timestamptz,
  inbox_id text,topic text,case_ids text[],complete_by timestamptz
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pgmq AS $$
DECLARE
  message record;
  inbox control_plane.shopify_compliance_inbox%ROWTYPE;
  target_count integer;
BEGIN
  PERFORM control_plane.assert_shopify_privacy_queue_ready();
  IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_visibility_timeout_seconds NOT BETWEEN 60 AND 3600
     OR p_quantity NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'Shopify privacy claim is invalid' USING ERRCODE='22023';
  END IF;
  FOR message IN
    SELECT * FROM pgmq.read(
      'albert_shopify_privacy',p_visibility_timeout_seconds,p_quantity
    )
  LOOP
    SELECT item.* INTO inbox
      FROM control_plane.shopify_compliance_inbox item
     WHERE item.inbox_id=message.message->>'inboxId'
       AND item.privacy_queue_message_id=message.msg_id
       AND item.status='dispatched'
       AND item.topic IN ('customers/data_request','customers/redact')
     FOR UPDATE;
    IF NOT FOUND THEN
      PERFORM pgmq.delete('albert_shopify_privacy',message.msg_id);
      CONTINUE;
    END IF;

    SELECT count(*)::integer INTO target_count
      FROM control_plane.shopify_privacy_cases item
     WHERE item.inbox_id=inbox.inbox_id;
    IF target_count=0 THEN
      INSERT INTO control_plane.shopify_privacy_cases (
        case_id,inbox_id,target_tenant_id,target_connection_id,
        target_connection_generation,topic,status,customer_reference,
        customer_contact_hmac,order_references,data_request_reference,
        received_at,complete_by
      )
      SELECT control_plane.generate_ulid(),inbox.inbox_id,target.tenant_id,
             target.connection_id,target.connection_generation,inbox.topic,'queued',
             inbox.customer_reference,inbox.customer_contact_hmac,
             inbox.order_references,inbox.data_request_reference,
             inbox.received_at,inbox.received_at+interval '30 days'
        FROM control_plane.shopify_compliance_targets target
       WHERE target.inbox_id=inbox.inbox_id
       ORDER BY target.tenant_id,target.connection_id
      ON CONFLICT (inbox_id,target_tenant_id,target_connection_id,
                   target_connection_generation) DO NOTHING;
      SELECT count(*)::integer INTO target_count
        FROM control_plane.shopify_privacy_cases item
       WHERE item.inbox_id=inbox.inbox_id;
    END IF;
    IF target_count<>inbox.target_count OR target_count=0 THEN
      RAISE EXCEPTION 'Shopify privacy target cardinality is inconsistent'
        USING ERRCODE='55000';
    END IF;

    INSERT INTO control_plane.shopify_privacy_job_attempts (
      inbox_id,attempt_number,worker_id,message_id,visibility_deadline
    ) VALUES (
      inbox.inbox_id,message.read_ct::integer,p_worker_id,message.msg_id,message.vt
    ) ON CONFLICT (inbox_id,attempt_number) DO NOTHING;

    message_id:=message.msg_id;
    read_count:=message.read_ct;
    visibility_deadline:=message.vt;
    inbox_id:=inbox.inbox_id;
    topic:=inbox.topic;
    SELECT array_agg(item.case_id ORDER BY item.case_id),max(item.complete_by)
      INTO case_ids,complete_by
      FROM control_plane.shopify_privacy_cases item
     WHERE item.inbox_id=inbox.inbox_id;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.require_active_shopify_privacy_lease(
  p_message_id bigint,p_inbox_id text,p_worker_id text,p_read_count integer
) RETURNS control_plane.shopify_compliance_inbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE inbox control_plane.shopify_compliance_inbox%ROWTYPE;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_deletion_control_runtime','albert_deletion_control'
  );
  SELECT source.* INTO inbox
    FROM control_plane.shopify_compliance_inbox source
    JOIN control_plane.shopify_privacy_job_attempts attempt
      ON attempt.inbox_id=source.inbox_id
     AND attempt.attempt_number=p_read_count
     AND attempt.worker_id=p_worker_id
   WHERE source.inbox_id=p_inbox_id
     AND source.privacy_queue_message_id=p_message_id
     AND source.status='dispatched'
     AND attempt.message_id=p_message_id
     AND attempt.outcome IS NULL
     AND attempt.visibility_deadline>clock_timestamp()
     AND NOT EXISTS (
       SELECT 1 FROM control_plane.shopify_privacy_job_attempts later
        WHERE later.inbox_id=source.inbox_id
          AND later.attempt_number>attempt.attempt_number
     )
   FOR UPDATE OF source,attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shopify privacy lease is no longer active'
      USING ERRCODE='55000';
  END IF;
  RETURN inbox;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.dispatch_shopify_customer_redaction(
  p_message_id bigint,p_inbox_id text,p_worker_id text,p_read_count integer
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  inbox control_plane.shopify_compliance_inbox%ROWTYPE;
  privacy_case control_plane.shopify_privacy_cases%ROWTYPE;
  connection control_plane.connections%ROWTYPE;
  request_id text;
  dispatched integer:=0;
BEGIN
  inbox:=control_plane.require_active_shopify_privacy_lease(
    p_message_id,p_inbox_id,p_worker_id,p_read_count
  );
  IF inbox.topic<>'customers/redact' THEN
    RAISE EXCEPTION 'Shopify privacy topic is not customer redaction'
      USING ERRCODE='22023';
  END IF;
  FOR privacy_case IN
    SELECT item.* FROM control_plane.shopify_privacy_cases item
     WHERE item.inbox_id=inbox.inbox_id
     ORDER BY item.target_tenant_id,item.target_connection_id
     FOR UPDATE
  LOOP
    SELECT item.* INTO connection
      FROM control_plane.connections item
     WHERE item.tenant_id=privacy_case.target_tenant_id
       AND item.connection_id=privacy_case.target_connection_id
       AND item.connection_generation=privacy_case.target_connection_generation
       AND item.connector_key='shopify'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shopify privacy target generation changed'
        USING ERRCODE='55000';
    END IF;

    UPDATE control_plane.connections item
       SET status='disconnected',auth_health='revoked',
           disconnected_at=coalesce(item.disconnected_at,inbox.received_at),
           ingestion_activated_at=NULL,ingestion_activated_by=NULL,
           ingestion_activated_generation=NULL,
           ingestion_blocked_reason='shopify_customer_redaction'
     WHERE item.tenant_id=privacy_case.target_tenant_id
       AND item.connection_id=privacy_case.target_connection_id
       AND item.connection_generation=privacy_case.target_connection_generation;
    UPDATE control_plane.readiness item
       SET state='blocked',reason_code='shopify_customer_redaction',
           reason_detail='Shopify customer redaction requires verified full-connection erasure.',
           evaluated_at=clock_timestamp()
     WHERE item.tenant_id=privacy_case.target_tenant_id
       AND item.connection_id=privacy_case.target_connection_id;

    request_id:=privacy_case.deletion_request_id;
    IF request_id IS NULL THEN
      SELECT request.deletion_request_id INTO request_id
        FROM control_plane.deletion_requests request
       WHERE request.tenant_id=privacy_case.target_tenant_id
         AND request.connection_id=privacy_case.target_connection_id
         AND request.scope='connection'
         AND request.status IN ('queued','running','retry_wait','verifying','failed')
       ORDER BY request.requested_at DESC
       LIMIT 1
       FOR UPDATE;
    END IF;
    IF request_id IS NULL THEN
      request_id:=control_plane.generate_ulid();
      INSERT INTO control_plane.deletion_requests (
        tenant_id,deletion_request_id,connection_id,scope,status,requested_by,
        remote_revocation_status,credential_destroyed_at,
        credential_destruction_due_at,purge_due_at,progress,requested_at
      ) VALUES (
        privacy_case.target_tenant_id,request_id,
        privacy_case.target_connection_id,'connection','queued',NULL,
        'unsupported',NULL,clock_timestamp()+interval '15 minutes',
        inbox.received_at,
        jsonb_build_object('shopify_customer_redaction',jsonb_build_object(
          'caseIds',jsonb_build_array(privacy_case.case_id),
          'inboxIds',jsonb_build_array(inbox.inbox_id),
          'firstReceivedAt',inbox.received_at,'latestReceivedAt',inbox.received_at,
          'fullConnectionPurge',true,
          'connectionGeneration',privacy_case.target_connection_generation
        )),clock_timestamp()
      );
      PERFORM control_plane.enqueue_deletion_request(request_id);
    ELSE
      UPDATE control_plane.deletion_requests request
         SET progress=jsonb_set(
           request.progress,'{shopify_customer_redaction}',
           jsonb_build_object(
             'caseIds',CASE
               WHEN coalesce(request.progress->'shopify_customer_redaction'->'caseIds','[]'::jsonb)
                    ? privacy_case.case_id
               THEN coalesce(request.progress->'shopify_customer_redaction'->'caseIds','[]'::jsonb)
               ELSE coalesce(request.progress->'shopify_customer_redaction'->'caseIds','[]'::jsonb)
                    || jsonb_build_array(privacy_case.case_id)
             END,
             'inboxIds',CASE
               WHEN coalesce(request.progress->'shopify_customer_redaction'->'inboxIds','[]'::jsonb)
                    ? inbox.inbox_id
               THEN coalesce(request.progress->'shopify_customer_redaction'->'inboxIds','[]'::jsonb)
               ELSE coalesce(request.progress->'shopify_customer_redaction'->'inboxIds','[]'::jsonb)
                    || jsonb_build_array(inbox.inbox_id)
             END,
             'firstReceivedAt',least(
               coalesce((request.progress->'shopify_customer_redaction'->>'firstReceivedAt')::timestamptz,
                        inbox.received_at),inbox.received_at
             ),
             'latestReceivedAt',greatest(
               coalesce((request.progress->'shopify_customer_redaction'->>'latestReceivedAt')::timestamptz,
                        inbox.received_at),inbox.received_at
             ),
             'fullConnectionPurge',true,
             'connectionGeneration',privacy_case.target_connection_generation
           ),true
         )
       WHERE request.tenant_id=privacy_case.target_tenant_id
         AND request.deletion_request_id=request_id
         AND request.status IN ('queued','running','retry_wait','verifying','failed')
         AND (
           request.progress->'shopify_customer_redaction'->>'connectionGeneration' IS NULL
           OR request.progress->'shopify_customer_redaction'->>'connectionGeneration'=
              privacy_case.target_connection_generation::text
         );
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Active deletion is bound to another Shopify generation'
          USING ERRCODE='55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM control_plane.deletion_requests request
         WHERE request.tenant_id=privacy_case.target_tenant_id
           AND request.deletion_request_id=request_id
           AND request.status IN ('queued','retry_wait','failed')
           AND request.queue_message_id IS NULL
      ) THEN
        PERFORM control_plane.enqueue_deletion_request(request_id);
      END IF;
    END IF;
    UPDATE control_plane.shopify_privacy_cases item
       SET status='redaction_dispatched',deletion_request_id=request_id,
           last_error_code=NULL
     WHERE item.case_id=privacy_case.case_id;
    dispatched:=dispatched+1;
  END LOOP;
  RETURN dispatched;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.prepare_shopify_customer_data_request(
  p_message_id bigint,p_inbox_id text,p_worker_id text,p_read_count integer
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE inbox control_plane.shopify_compliance_inbox%ROWTYPE; prepared integer;
BEGIN
  inbox:=control_plane.require_active_shopify_privacy_lease(
    p_message_id,p_inbox_id,p_worker_id,p_read_count
  );
  IF inbox.topic<>'customers/data_request' THEN
    RAISE EXCEPTION 'Shopify privacy topic is not a customer data request'
      USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.shopify_privacy_cases item
     SET status=CASE
           WHEN item.customer_reference IS NULL
             AND cardinality(item.order_references)=0
           THEN 'attention_required'
           ELSE 'awaiting_operator_export'
         END,
         last_error_code=CASE
           WHEN item.customer_reference IS NULL
             AND cardinality(item.order_references)=0
           THEN 'unresolvable_customer_identity'
           ELSE NULL
         END
   WHERE item.inbox_id=inbox.inbox_id AND item.status='queued';
  SELECT count(*)::integer INTO prepared
    FROM control_plane.shopify_privacy_cases item
   WHERE item.inbox_id=inbox.inbox_id
     AND item.status IN (
       'awaiting_operator_export','export_in_progress','awaiting_delivery','completed'
       ,'attention_required'
     );
  RETURN prepared;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_shopify_privacy_job(
  p_message_id bigint,p_inbox_id text,p_worker_id text,p_read_count integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pgmq AS $$
DECLARE inbox control_plane.shopify_compliance_inbox%ROWTYPE;
BEGIN
  inbox:=control_plane.require_active_shopify_privacy_lease(
    p_message_id,p_inbox_id,p_worker_id,p_read_count
  );
  IF EXISTS (
    SELECT 1 FROM control_plane.shopify_privacy_cases item
     WHERE item.inbox_id=inbox.inbox_id
       AND (
         (inbox.topic='customers/redact'
             AND item.status NOT IN ('redaction_dispatched','completed'))
         OR (inbox.topic='customers/data_request'
             AND item.status NOT IN (
               'awaiting_operator_export','export_in_progress','awaiting_delivery',
               'attention_required','completed'
             ))
       )
  ) THEN
    RAISE EXCEPTION 'Shopify privacy dispatch is incomplete' USING ERRCODE='55000';
  END IF;
  IF NOT pgmq.delete('albert_shopify_privacy',p_message_id) THEN
    RAISE EXCEPTION 'Shopify privacy queue message could not be removed'
      USING ERRCODE='55000';
  END IF;
  UPDATE control_plane.shopify_privacy_job_attempts
     SET outcome='succeeded',finished_at=clock_timestamp()
   WHERE inbox_id=p_inbox_id AND attempt_number=p_read_count
     AND worker_id=p_worker_id AND outcome IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.retry_shopify_privacy_job(
  p_message_id bigint,p_inbox_id text,p_worker_id text,p_read_count integer,
  p_error jsonb,p_retry_delay_seconds integer
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pgmq AS $$
DECLARE inbox control_plane.shopify_compliance_inbox%ROWTYPE; deadline timestamptz;
BEGIN
  inbox:=control_plane.require_active_shopify_privacy_lease(
    p_message_id,p_inbox_id,p_worker_id,p_read_count
  );
  IF p_retry_delay_seconds NOT BETWEEN 5 AND 3600
     OR jsonb_typeof(p_error)<>'object'
     OR NOT p_error ?& ARRAY['code','errorClass','correlationId','retryable','failedAt']
     OR p_error-ARRAY['code','errorClass','correlationId','retryable','failedAt']<>'{}'::jsonb
     OR p_error->>'code' !~ '^[a-z][a-z0-9_]{0,79}$'
     OR p_error->>'errorClass' NOT IN ('connector','database','timeout','internal')
     OR NOT control_plane.is_ulid(p_error->>'correlationId')
     OR p_error->'retryable' IS DISTINCT FROM 'true'::jsonb
     OR p_error->>'failedAt' !~
       '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$' THEN
    RAISE EXCEPTION 'Shopify privacy retry evidence is invalid' USING ERRCODE='22023';
  END IF;
  deadline:=inbox.received_at+interval '30 days';
  UPDATE control_plane.shopify_privacy_job_attempts
     SET outcome=CASE WHEN clock_timestamp()>=deadline THEN 'failed' ELSE 'retry' END,
         error_metadata=p_error,finished_at=clock_timestamp()
   WHERE inbox_id=p_inbox_id AND attempt_number=p_read_count
     AND worker_id=p_worker_id AND outcome IS NULL;
  UPDATE control_plane.shopify_privacy_cases
     SET last_error_code=p_error->>'code',
         overdue_at=CASE WHEN clock_timestamp()>=deadline
                         THEN coalesce(overdue_at,clock_timestamp()) ELSE overdue_at END
   WHERE inbox_id=p_inbox_id AND status<>'completed';
  IF clock_timestamp()>=deadline THEN
    PERFORM pgmq.delete('albert_shopify_privacy',p_message_id);
    UPDATE control_plane.shopify_privacy_cases
       SET status='attention_required'
     WHERE inbox_id=p_inbox_id AND status='queued';
    RETURN 'attention_required';
  END IF;
  PERFORM pgmq.set_vt('albert_shopify_privacy',p_message_id,p_retry_delay_seconds);
  RETURN 'retry_wait';
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.reconcile_shopify_privacy_cases()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE completed_redactions integer; overdue integer; attention integer;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_deletion_control_runtime','albert_deletion_control'
  );
  UPDATE control_plane.shopify_privacy_exports
     SET status='expired',completed_at=clock_timestamp(),
         error_code='EXPORT_GRANT_EXPIRED'
   WHERE status IN ('requested','claimed') AND expires_at<=clock_timestamp();
  UPDATE control_plane.shopify_privacy_cases privacy_case
     SET status='awaiting_operator_export',last_error_code='export_grant_expired'
   WHERE privacy_case.topic='customers/data_request'
     AND privacy_case.status='export_in_progress'
     AND NOT EXISTS (
       SELECT 1 FROM control_plane.shopify_privacy_exports export
        WHERE export.case_id=privacy_case.case_id
          AND export.status IN ('requested','claimed')
     );
  UPDATE control_plane.shopify_privacy_cases privacy_case
     SET status='completed',completed_at=coalesce(completed_at,clock_timestamp()),
         customer_reference=NULL,customer_contact_hmac=NULL,
         order_references=ARRAY[]::text[],last_error_code=NULL
   WHERE privacy_case.topic='customers/redact'
     AND privacy_case.status<>'completed'
     AND EXISTS (
       SELECT 1 FROM control_plane.deletion_requests request
       JOIN control_plane.deletion_proofs proof
         ON proof.deletion_request_id=request.deletion_request_id
        WHERE request.tenant_id=privacy_case.target_tenant_id
          AND request.deletion_request_id=privacy_case.deletion_request_id
          AND request.status='completed' AND request.proof_id=proof.proof_id
          AND proof.requested_at=request.requested_at
          AND proof.completed_at>=privacy_case.received_at
          AND coalesce(request.progress->'shopify_customer_redaction'->'caseIds','[]'::jsonb)
              ? privacy_case.case_id
          AND coalesce(request.progress->'shopify_customer_redaction'->'inboxIds','[]'::jsonb)
              ? privacy_case.inbox_id
          AND request.progress->'shopify_customer_redaction'->>'connectionGeneration'=
              privacy_case.target_connection_generation::text
     );
  GET DIAGNOSTICS completed_redactions=ROW_COUNT;

  UPDATE control_plane.shopify_compliance_inbox inbox
     SET customer_reference=NULL,customer_contact_hmac=NULL,
         order_references=ARRAY[]::text[],redacted_at=clock_timestamp()
   WHERE inbox.topic='customers/redact' AND inbox.redacted_at IS NULL
     AND EXISTS (
       SELECT 1 FROM control_plane.shopify_privacy_cases privacy_case
        WHERE privacy_case.inbox_id=inbox.inbox_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM control_plane.shopify_privacy_cases privacy_case
        WHERE privacy_case.inbox_id=inbox.inbox_id
          AND privacy_case.status<>'completed'
     );

  UPDATE control_plane.shopify_privacy_cases privacy_case
     SET status='attention_required',
         last_error_code=coalesce(request.last_error_code,'deletion_failed')
    FROM control_plane.deletion_requests request
   WHERE request.tenant_id=privacy_case.target_tenant_id
     AND request.deletion_request_id=privacy_case.deletion_request_id
     AND request.status='failed' AND privacy_case.status='redaction_dispatched';

  UPDATE control_plane.shopify_privacy_cases
     SET overdue_at=coalesce(overdue_at,clock_timestamp())
   WHERE status<>'completed' AND complete_by<=clock_timestamp()
     AND overdue_at IS NULL;
  GET DIAGNOSTICS overdue=ROW_COUNT;
  SELECT count(*)::integer INTO attention
    FROM control_plane.shopify_privacy_cases
   WHERE status='attention_required';
  RETURN jsonb_build_object(
    'completedRedactions',completed_redactions,
    'newlyOverdue',overdue,'attentionRequired',attention
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.shopify_privacy_queue_metrics()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pgmq AS $$
DECLARE result jsonb;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_deletion_control_runtime','albert_deletion_control'
  );
  SELECT jsonb_build_object(
    'openCases',count(*) FILTER (WHERE status<>'completed'),
    'overdueCases',count(*) FILTER (
      WHERE status<>'completed' AND complete_by<=clock_timestamp()
    ),
    'attentionRequired',count(*) FILTER (WHERE status='attention_required'),
    'oldestCompleteBy',min(complete_by) FILTER (WHERE status<>'completed'),
    'visibleQueueMessages',(
      SELECT count(*) FROM pgmq.q_albert_shopify_privacy
       WHERE vt<=clock_timestamp()
    )
  ) INTO result FROM control_plane.shopify_privacy_cases;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_shopify_privacy_cases()
RETURNS TABLE (
  case_id text,topic text,status text,target_tenant_id text,
  target_connection_id text,customer_reference text,
  order_references text[],data_request_reference text,
  complete_by timestamptz,overdue boolean,last_error_code text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF extensions.albert_auth_uid() IS NULL OR NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT item.case_id,item.topic,item.status,item.target_tenant_id,
         item.target_connection_id,item.customer_reference,item.order_references,
         item.data_request_reference,item.complete_by,
         item.status<>'completed' AND item.complete_by<=clock_timestamp(),
         item.last_error_code
    FROM control_plane.shopify_privacy_cases item
   ORDER BY (item.status<>'completed') DESC,item.complete_by,item.case_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_albert_shopify_privacy_export(
  p_case_id text,p_export_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=extensions.albert_auth_uid(); privacy_case control_plane.shopify_privacy_cases%ROWTYPE;
DECLARE issued_at timestamptz:=clock_timestamp(); expiry timestamptz:=issued_at+interval '10 minutes';
BEGIN
  IF actor IS NULL OR NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE='42501';
  END IF;
  IF NOT control_plane.is_ulid(p_case_id) OR NOT control_plane.is_ulid(p_export_id) THEN
    RAISE EXCEPTION 'Shopify privacy export identifiers are invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO privacy_case FROM control_plane.shopify_privacy_cases
   WHERE case_id=p_case_id FOR UPDATE;
  IF NOT FOUND OR privacy_case.topic<>'customers/data_request' THEN
    RAISE EXCEPTION 'Shopify customer data request was not found' USING ERRCODE='P0002';
  END IF;
  IF privacy_case.status NOT IN (
    'awaiting_operator_export','attention_required','awaiting_delivery'
  ) THEN
    RAISE EXCEPTION 'Shopify customer data request is not exportable' USING ERRCODE='55000';
  END IF;
  IF privacy_case.customer_reference IS NULL
     AND cardinality(privacy_case.order_references)=0 THEN
    RAISE EXCEPTION 'Shopify customer identity is not analytically addressable'
      USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('shopify-privacy-export:'||actor::text,0));
  IF (SELECT count(*) FROM control_plane.shopify_privacy_exports item
       WHERE item.actor_user_id=actor AND item.requested_at>issued_at-interval '1 hour')>=20 THEN
    RAISE EXCEPTION 'Shopify privacy export rate limit exceeded' USING ERRCODE='P0001';
  END IF;
  INSERT INTO control_plane.shopify_privacy_exports (
    export_id,case_id,actor_user_id,status,requested_at,expires_at
  ) VALUES (p_export_id,p_case_id,actor,'requested',issued_at,expiry);
  UPDATE control_plane.shopify_privacy_cases
     SET status='export_in_progress',last_error_code=NULL WHERE case_id=p_case_id;
  INSERT INTO control_plane.operator_audit_log (
    operator_audit_id,actor_user_id,action,target_tenant_id,request_metadata
  ) VALUES (
    control_plane.generate_ulid(),actor,'shopify.privacy_export_requested',
    privacy_case.target_tenant_id,
    jsonb_build_object('case_id',p_case_id,'export_id',p_export_id)
  );
  RETURN jsonb_build_object('case_id',p_case_id,'export_id',p_export_id,'expires_at',expiry);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.claim_shopify_privacy_export(p_export_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE export control_plane.shopify_privacy_exports%ROWTYPE;
DECLARE privacy_case control_plane.shopify_privacy_cases%ROWTYPE; capability text;
BEGIN
  PERFORM control_plane.assert_operator_diagnostic_control_ready();
  IF NOT control_plane.is_ulid(p_export_id) THEN
    RAISE EXCEPTION 'Shopify privacy export identifier is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO export FROM control_plane.shopify_privacy_exports
   WHERE export_id=p_export_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shopify privacy export was not found' USING ERRCODE='P0002'; END IF;
  IF export.status<>'requested' OR export.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Shopify privacy export is unavailable or expired' USING ERRCODE='55000';
  END IF;
  SELECT * INTO STRICT privacy_case FROM control_plane.shopify_privacy_cases
   WHERE case_id=export.case_id FOR UPDATE;
  UPDATE control_plane.shopify_privacy_exports
     SET status='claimed',claimed_at=clock_timestamp() WHERE export_id=p_export_id;
  capability:=control_plane.sign_analytical_capability(
    privacy_case.target_tenant_id,'analytical:diagnostic','diagnostic',
    'shopify-privacy-export:'||p_export_id,export.expires_at,
    jsonb_build_object('kind','shopify_privacy_export','export_id',p_export_id,
                       'case_id',privacy_case.case_id,
                       'connection_id',privacy_case.target_connection_id)
  );
  RETURN jsonb_build_object(
    'export_id',p_export_id,'case_id',privacy_case.case_id,
    'tenant_id',privacy_case.target_tenant_id,
    'connection_id',privacy_case.target_connection_id,
    'customer_reference',privacy_case.customer_reference,
    'order_references',privacy_case.order_references,
    'data_request_reference',privacy_case.data_request_reference,
    'expires_at',export.expires_at,'analytical_capability',capability
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_shopify_privacy_export(
  p_export_id text,p_status text,p_artifact_sha256 text,p_record_count integer,
  p_error_code text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE export control_plane.shopify_privacy_exports%ROWTYPE; privacy_case control_plane.shopify_privacy_cases%ROWTYPE;
BEGIN
  PERFORM control_plane.assert_operator_diagnostic_control_ready();
  IF p_status NOT IN ('completed','failed')
     OR (p_status='completed' AND (
       p_artifact_sha256 !~ '^[0-9a-f]{64}$' OR p_record_count<0 OR p_error_code IS NOT NULL
     ))
     OR (p_status='failed' AND (
       p_artifact_sha256 IS NOT NULL OR p_record_count IS NOT NULL
       OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,79}$'
     )) THEN
    RAISE EXCEPTION 'Shopify privacy export outcome is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO export FROM control_plane.shopify_privacy_exports
   WHERE export_id=p_export_id FOR UPDATE;
  IF NOT FOUND OR export.status<>'claimed' THEN
    RAISE EXCEPTION 'Claimed Shopify privacy export was not found' USING ERRCODE='P0002';
  END IF;
  SELECT * INTO STRICT privacy_case FROM control_plane.shopify_privacy_cases
   WHERE case_id=export.case_id FOR UPDATE;
  UPDATE control_plane.shopify_privacy_exports SET
    status=p_status,completed_at=clock_timestamp(),artifact_sha256=p_artifact_sha256,
    record_count=p_record_count,error_code=p_error_code
   WHERE export_id=p_export_id;
  UPDATE control_plane.shopify_privacy_cases SET
    status=CASE
      WHEN p_status='completed' THEN 'awaiting_delivery'
      WHEN p_error_code IN (
        'SHOPIFY_PRIVACY_EXPORT_TOO_LARGE',
        'SHOPIFY_PRIVACY_UNRESOLVABLE_IDENTITY'
      ) THEN 'attention_required'
      ELSE 'awaiting_operator_export'
    END,
    last_error_code=CASE WHEN p_status='failed' THEN lower(p_error_code) ELSE NULL END
   WHERE case_id=privacy_case.case_id;
  INSERT INTO control_plane.operator_audit_log (
    operator_audit_id,actor_user_id,action,target_tenant_id,request_metadata
  ) VALUES (
    control_plane.generate_ulid(),export.actor_user_id,
    CASE WHEN p_status='completed' THEN 'shopify.privacy_export_completed'
         ELSE 'shopify.privacy_export_failed' END,
    privacy_case.target_tenant_id,
    jsonb_build_object('case_id',privacy_case.case_id,'export_id',p_export_id,
                       'status',p_status,'record_count',p_record_count,
                       'artifact_sha256',p_artifact_sha256,'error_code',p_error_code)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_albert_shopify_privacy_delivery(
  p_case_id text,p_export_id text,p_delivery_channel text,p_delivered_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=extensions.albert_auth_uid(); privacy_case control_plane.shopify_privacy_cases%ROWTYPE;
DECLARE export control_plane.shopify_privacy_exports%ROWTYPE;
BEGIN
  IF actor IS NULL OR NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE='42501';
  END IF;
  IF p_delivery_channel NOT IN ('direct_to_shop_owner','approved_secure_portal')
     OR p_delivered_at IS NULL OR p_delivered_at>clock_timestamp()+interval '1 minute' THEN
    RAISE EXCEPTION 'Shopify privacy delivery evidence is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO privacy_case FROM control_plane.shopify_privacy_cases
   WHERE case_id=p_case_id FOR UPDATE;
  SELECT * INTO export FROM control_plane.shopify_privacy_exports
   WHERE export_id=p_export_id AND case_id=p_case_id FOR UPDATE;
  IF NOT FOUND OR export.status<>'completed' OR privacy_case.status<>'awaiting_delivery'
     OR p_delivered_at<export.completed_at THEN
    RAISE EXCEPTION 'Completed Shopify privacy export was not found' USING ERRCODE='P0002';
  END IF;
  INSERT INTO control_plane.shopify_privacy_delivery_evidence (
    case_id,export_id,actor_user_id,artifact_sha256,record_count,
    delivery_channel,delivered_at
  ) VALUES (
    p_case_id,p_export_id,actor,export.artifact_sha256,export.record_count,
    p_delivery_channel,p_delivered_at
  );
  UPDATE control_plane.shopify_privacy_cases SET
    status='completed',completed_at=clock_timestamp(),customer_reference=NULL,
    customer_contact_hmac=NULL,order_references=ARRAY[]::text[],
    data_request_reference=NULL,last_error_code=NULL
   WHERE case_id=p_case_id;
  INSERT INTO control_plane.operator_audit_log (
    operator_audit_id,actor_user_id,action,target_tenant_id,request_metadata
  ) VALUES (
    control_plane.generate_ulid(),actor,'shopify.privacy_delivery_recorded',
    privacy_case.target_tenant_id,
    jsonb_build_object('case_id',p_case_id,'export_id',p_export_id,
                       'delivery_channel',p_delivery_channel,
                       'artifact_sha256',export.artifact_sha256,
                       'record_count',export.record_count,'delivered_at',p_delivered_at)
  );
  RETURN jsonb_build_object('case_id',p_case_id,'status','completed');
END;
$$;

REVOKE ALL ON TABLE
  control_plane.shopify_privacy_case_status_lookup,
  control_plane.shopify_privacy_export_status_lookup,
  control_plane.shopify_privacy_cases,
  control_plane.shopify_privacy_job_attempts,
  control_plane.shopify_privacy_exports,
  control_plane.shopify_privacy_delivery_evidence
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;

REVOKE ALL ON FUNCTION control_plane.touch_shopify_privacy_case(),
  control_plane.reject_shopify_privacy_delivery_mutation(),
  control_plane.assert_shopify_privacy_queue_ready(),
  control_plane.claim_shopify_privacy_jobs(text,integer,integer),
  control_plane.require_active_shopify_privacy_lease(bigint,text,text,integer),
  control_plane.dispatch_shopify_customer_redaction(bigint,text,text,integer),
  control_plane.prepare_shopify_customer_data_request(bigint,text,text,integer),
  control_plane.complete_shopify_privacy_job(bigint,text,text,integer),
  control_plane.retry_shopify_privacy_job(bigint,text,text,integer,jsonb,integer),
  control_plane.reconcile_shopify_privacy_cases(),
  control_plane.shopify_privacy_queue_metrics(),
  control_plane.claim_shopify_privacy_export(text),
  control_plane.complete_shopify_privacy_export(text,text,text,integer,text)
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;
REVOKE ALL ON FUNCTION public.albert_shopify_privacy_cases(),
  public.begin_albert_shopify_privacy_export(text,text),
  public.complete_albert_shopify_privacy_delivery(text,text,text,timestamptz)
FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION
  control_plane.assert_shopify_privacy_queue_ready(),
  control_plane.claim_shopify_privacy_jobs(text,integer,integer),
  control_plane.dispatch_shopify_customer_redaction(bigint,text,text,integer),
  control_plane.prepare_shopify_customer_data_request(bigint,text,text,integer),
  control_plane.complete_shopify_privacy_job(bigint,text,text,integer),
  control_plane.retry_shopify_privacy_job(bigint,text,text,integer,jsonb,integer),
  control_plane.reconcile_shopify_privacy_cases(),
  control_plane.shopify_privacy_queue_metrics()
TO albert_deletion_control;

GRANT EXECUTE ON FUNCTION
  control_plane.claim_shopify_privacy_export(text),
  control_plane.complete_shopify_privacy_export(text,text,text,integer,text)
TO albert_operator_diagnostic_control;

GRANT EXECUTE ON FUNCTION
  public.albert_shopify_privacy_cases(),
  public.begin_albert_shopify_privacy_export(text,text),
  public.complete_albert_shopify_privacy_delivery(text,text,text,timestamptz)
TO authenticated;

COMMENT ON TABLE control_plane.shopify_privacy_cases IS
  'Durable per-connection Shopify customer privacy obligations. Redaction completion requires a verified Albert deletion proof; data-request completion requires a produced export and explicit secure-delivery evidence.';
COMMENT ON FUNCTION control_plane.dispatch_shopify_customer_redaction(bigint,text,text,integer) IS
  'Fences the exact attested Shopify generation and dispatches full-connection verified deletion because immutable raw JSONL cannot be surgically redacted at customer grain.';

COMMIT;
