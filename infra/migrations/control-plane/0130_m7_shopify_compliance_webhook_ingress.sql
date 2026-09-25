BEGIN;

-- Official Shopify sources, pinned to 2026-07:
-- https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
-- https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
-- https://shopify.dev/docs/apps/build/webhooks/delivery-structure
-- https://shopify.dev/docs/apps/build/webhooks/subscribe
-- https://shopify.dev/docs/api/webhooks/2026-07
--
-- The three mandatory compliance topics must be accepted independently of a
-- merchant's ingestion choice. app/uninstalled is an installation lifecycle
-- event and therefore shares this always-on boundary. No operational topic is
-- admitted here. The gateway authenticates exact bytes with the app client
-- secret and sends only this bounded, independently attested envelope: the
-- source JSON and customer contact values never enter control-plane storage.

SELECT extensions.albert_install_shopify_privacy_queue();

-- Keep this receipt state machine independent from operational webhook
-- receipts: a compliance delivery is either durably dispatched to an Albert
-- obligation or retained as unresolved, and it never enters ingestion's
-- received/queued/failed lifecycle.
CREATE TABLE control_plane.shopify_compliance_inbox_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.shopify_compliance_inbox_status_lookup (
  status,description
) VALUES
  ('dispatched','Durable privacy or lifecycle deletion work exists for every resolved Albert target'),
  ('unresolved','The authenticated Shopify delivery has no matching Albert connection and remains available for reconciliation');

CREATE TABLE control_plane.shopify_compliance_inbox (
  inbox_id text PRIMARY KEY CHECK (control_plane.is_ulid(inbox_id)),
  webhook_id text NOT NULL UNIQUE
    CHECK (length(btrim(webhook_id)) BETWEEN 1 AND 160 AND webhook_id !~ '[[:cntrl:]]'),
  event_id text CHECK (
    event_id IS NULL OR
    (length(btrim(event_id)) BETWEEN 1 AND 160 AND event_id !~ '[[:cntrl:]]')
  ),
  topic text NOT NULL CHECK (topic IN (
    'customers/data_request','customers/redact','shop/redact','app/uninstalled'
  )),
  shop_reference_hmac text NOT NULL CHECK (shop_reference_hmac ~ '^[0-9a-f]{64}$'),
  shop_id text NOT NULL CHECK (shop_id ~ '^(0|[1-9][0-9]{0,29})$'),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  api_version text NOT NULL CHECK (api_version = '2026-07'),
  customer_reference text CHECK (
    customer_reference IS NULL OR customer_reference ~ '^(0|[1-9][0-9]{0,29})$'
  ),
  customer_contact_hmac text CHECK (
    customer_contact_hmac IS NULL OR customer_contact_hmac ~ '^[0-9a-f]{64}$'
  ),
  order_references text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (
    cardinality(order_references) <= 5000
  ),
  data_request_reference text CHECK (
    data_request_reference IS NULL OR
    data_request_reference ~ '^(0|[1-9][0-9]{0,29})$'
  ),
  status text NOT NULL
    REFERENCES control_plane.shopify_compliance_inbox_status_lookup(status),
  target_count integer NOT NULL CHECK (target_count >= 0),
  privacy_queue_message_id bigint,
  deletion_request_ids text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (
    cardinality(deletion_request_ids) <= 1000
  ),
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT shopify_compliance_inbox_topic_payload_check CHECK (
    (
      topic='customers/data_request'
      AND data_request_reference IS NOT NULL
      AND (customer_reference IS NOT NULL OR customer_contact_hmac IS NOT NULL)
    ) OR (
      topic='customers/redact'
      AND data_request_reference IS NULL
      AND (customer_reference IS NOT NULL OR customer_contact_hmac IS NOT NULL)
    ) OR (
      topic IN ('shop/redact','app/uninstalled')
      AND customer_reference IS NULL
      AND customer_contact_hmac IS NULL
      AND cardinality(order_references)=0
      AND data_request_reference IS NULL
    )
  ),
  CHECK (
    (topic IN ('customers/data_request','customers/redact') AND (
      (status='dispatched' AND privacy_queue_message_id IS NOT NULL AND target_count>0)
      OR (status='unresolved' AND privacy_queue_message_id IS NULL AND target_count=0)
    ))
    OR (topic IN ('shop/redact','app/uninstalled')
      AND privacy_queue_message_id IS NULL)
  )
);

-- Resolve the shop domain only inside the attested SECURITY DEFINER function,
-- then discard it. A privacy consumer receives exact Albert identities and
-- never needs the Shopify client secret or a plaintext shop domain.
CREATE TABLE control_plane.shopify_compliance_targets (
  inbox_id text NOT NULL REFERENCES control_plane.shopify_compliance_inbox(inbox_id)
    ON DELETE CASCADE,
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  PRIMARY KEY (inbox_id,tenant_id,connection_id,connection_generation),
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id) ON DELETE RESTRICT
);

COMMENT ON TABLE control_plane.shopify_compliance_inbox IS
  'Minimal HMAC-authenticated Shopify compliance/lifecycle receipt. It intentionally excludes the source body, shop domain, customer email/phone, names, addresses, and every operational object. Official contract: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance';
COMMENT ON COLUMN control_plane.shopify_compliance_inbox.status IS
  'dispatched means durable customer privacy work or connection deletion work exists. unresolved means the authenticated shop currently has no Albert Shopify connection; the receipt remains durable for operator reconciliation.';

ALTER TABLE control_plane.shopify_compliance_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopify_compliance_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
  control_plane.shopify_compliance_inbox_status_lookup,
  control_plane.shopify_compliance_inbox,
  control_plane.shopify_compliance_targets
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;

CREATE OR REPLACE FUNCTION control_plane.accept_attested_shopify_compliance_webhook(
  p_document text,
  p_issued_at bigint,
  p_nonce text,
  p_key_id text,
  p_signature text
) RETURNS TABLE (
  inbox_id text,
  status text,
  duplicate boolean,
  target_count integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog,pgmq
AS $$
DECLARE
  document jsonb;
  generated_inbox_id text;
  existing control_plane.shopify_compliance_inbox%ROWTYPE;
  candidate record;
  requested_at timestamptz;
  customer_reference text;
  customer_contact_hmac text;
  data_request_reference text;
  orders text[];
  generated_message_id bigint;
  generated_request_id text;
  deletion_ids text[]:=ARRAY[]::text[];
  resolved_targets jsonb:='[]'::jsonb;
  targets integer:=0;
  dispatched_status text;
BEGIN
  BEGIN document:=p_document::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Shopify compliance attestation document is invalid'
      USING ERRCODE='22023';
  END;
  generated_inbox_id:=document->>'inboxId';
  document:=control_plane.consume_webhook_attestation(
    'shopify.accept',generated_inbox_id,p_document,p_issued_at,
    p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document,ARRAY[
       'version','operation','inboxId','webhookId','eventId','topic','shopDomain',
       'shopReferenceHmac','apiVersion','bodySha256','shopId','customerReference',
       'customerContactHmac','orderReferences','dataRequestReference','receivedAt'
     ])
     OR document->>'version'<>'1'
     OR document->>'operation'<>'shopify.accept'
     OR NOT control_plane.is_ulid(generated_inbox_id)
     OR jsonb_typeof(document->'webhookId')<>'string'
     OR length(btrim(document->>'webhookId')) NOT BETWEEN 1 AND 160
     OR document->>'webhookId' ~ '[[:cntrl:]]'
     OR NOT (
       jsonb_typeof(document->'eventId')='null'
       OR (
         jsonb_typeof(document->'eventId')='string'
         AND length(btrim(document->>'eventId')) BETWEEN 1 AND 160
         AND document->>'eventId' !~ '[[:cntrl:]]'
       )
     )
     OR document->>'topic' NOT IN (
       'customers/data_request','customers/redact','shop/redact','app/uninstalled'
     )
     OR document->>'shopDomain' !~ '^[a-z0-9][a-z0-9-]{0,61}[.]myshopify[.]com$'
     OR document->>'shopReferenceHmac' !~ '^[0-9a-f]{64}$'
     OR document->>'apiVersion'<>'2026-07'
     OR document->>'bodySha256' !~ '^[0-9a-f]{64}$'
     OR document->>'shopId' !~ '^(0|[1-9][0-9]{0,29})$'
     OR jsonb_typeof(document->'orderReferences')<>'array'
     OR jsonb_array_length(document->'orderReferences')>5000 THEN
    RAISE EXCEPTION 'Shopify compliance attestation document is invalid'
      USING ERRCODE='22023';
  END IF;
  requested_at:=control_plane.webhook_document_timestamp(document,'receivedAt');
  customer_reference:=CASE
    WHEN jsonb_typeof(document->'customerReference')='null' THEN NULL
    WHEN jsonb_typeof(document->'customerReference')='string'
      AND document->>'customerReference' ~ '^(0|[1-9][0-9]{0,29})$'
      THEN document->>'customerReference'
    ELSE '#invalid#'
  END;
  customer_contact_hmac:=CASE
    WHEN jsonb_typeof(document->'customerContactHmac')='null' THEN NULL
    WHEN jsonb_typeof(document->'customerContactHmac')='string'
      AND document->>'customerContactHmac' ~ '^[0-9a-f]{64}$'
      THEN document->>'customerContactHmac'
    ELSE '#invalid#'
  END;
  data_request_reference:=CASE
    WHEN jsonb_typeof(document->'dataRequestReference')='null' THEN NULL
    WHEN jsonb_typeof(document->'dataRequestReference')='string'
      AND document->>'dataRequestReference' ~ '^(0|[1-9][0-9]{0,29})$'
      THEN document->>'dataRequestReference'
    ELSE '#invalid#'
  END;
  SELECT coalesce(array_agg(value ORDER BY value),ARRAY[]::text[])
    INTO orders
    FROM jsonb_array_elements_text(document->'orderReferences') AS item(value);
  IF customer_reference='#invalid#' OR customer_contact_hmac='#invalid#'
     OR data_request_reference='#invalid#'
     OR cardinality(orders)<>(SELECT count(DISTINCT value) FROM unnest(orders) AS item(value))
     OR EXISTS (
       SELECT 1 FROM unnest(orders) AS item(value)
       WHERE item.value !~ '^(0|[1-9][0-9]{0,29})$'
     )
     OR (
       document->>'topic'='customers/data_request'
       AND (
         data_request_reference IS NULL
         OR (customer_reference IS NULL AND customer_contact_hmac IS NULL)
       )
     )
     OR (
       document->>'topic'='customers/redact'
       AND (
         data_request_reference IS NOT NULL
         OR (customer_reference IS NULL AND customer_contact_hmac IS NULL)
       )
     )
     OR (
       document->>'topic' IN ('shop/redact','app/uninstalled')
       AND (
         customer_reference IS NOT NULL OR customer_contact_hmac IS NOT NULL
         OR data_request_reference IS NOT NULL OR cardinality(orders)>0
       )
     ) THEN
    RAISE EXCEPTION 'Shopify compliance attestation document is invalid'
      USING ERRCODE='22023';
  END IF;

  -- Shopify documents duplicate delivery; serialize the same delivery ID so
  -- concurrent retries return the committed receipt rather than racing the
  -- unique constraint after creating duplicate queue work.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'albert:shopify-compliance:'||(document->>'webhookId'),0
  ));
  SELECT item.* INTO existing
    FROM control_plane.shopify_compliance_inbox AS item
   WHERE item.webhook_id=document->>'webhookId'
   FOR UPDATE;
  IF FOUND THEN
    IF existing.body_sha256<>document->>'bodySha256'
       OR existing.topic<>document->>'topic'
       OR existing.shop_reference_hmac<>document->>'shopReferenceHmac' THEN
      RAISE EXCEPTION 'Shopify webhook dedupe collision' USING ERRCODE='22000';
    END IF;
    RETURN QUERY SELECT existing.inbox_id,existing.status,true,existing.target_count;
    RETURN;
  END IF;

  -- Resolve only after independently verified app HMAC. Include disconnected
  -- rows because they can retain data while an earlier purge is pending. The
  -- exact targets are immutable inputs to the customer privacy consumer.
  FOR candidate IN
    SELECT connection.*
    FROM control_plane.connections AS connection
    WHERE connection.connector_key='shopify'
      AND lower(connection.external_account_reference)=document->>'shopDomain'
      AND connection.status IN ('connected','degraded','disconnected')
    ORDER BY connection.tenant_id,connection.connection_id
    FOR UPDATE
  LOOP
    resolved_targets:=resolved_targets||jsonb_build_array(jsonb_build_object(
      'tenantId',candidate.tenant_id,
      'connectionId',candidate.connection_id,
      'connectionGeneration',candidate.connection_generation
    ));
    targets:=targets+1;
  END LOOP;

  IF targets<>jsonb_array_length(resolved_targets) THEN
    RAISE EXCEPTION 'Shopify compliance target cardinality is inconsistent'
      USING ERRCODE='55000';
  END IF;

  IF document->>'topic' IN ('customers/data_request','customers/redact') THEN
    IF targets>0 THEN
      SELECT send INTO generated_message_id FROM pgmq.send(
        'albert_shopify_privacy',
        jsonb_strip_nulls(jsonb_build_object(
          'schemaVersion',1,
          'inboxId',generated_inbox_id,
          'topic',document->>'topic',
          'shopId',document->>'shopId',
          'targets',resolved_targets,
          'customerReference',customer_reference,
          'customerContactHmac',customer_contact_hmac,
          'orderReferences',orders,
          'dataRequestReference',data_request_reference,
          'receivedAt',requested_at,
          'completeBy',requested_at+interval '30 days'
        )),0
      );
      IF document->>'topic'='customers/redact' THEN
        -- Redaction is destructive and raw Shopify payloads are stored at
        -- connection-batch grain. Fence only the exact, already-attested
        -- connection generations before acknowledging durable work. This
        -- prevents OAuth, schedules, and a new manual activation from racing
        -- the privacy consumer. A duplicate delivery returns above and is
        -- therefore idempotent. customers/data_request remains read-only.
        UPDATE control_plane.connections AS connection
           SET status='disconnected',auth_health='revoked',
               disconnected_at=requested_at,
               ingestion_activated_at=NULL,ingestion_activated_by=NULL,
               ingestion_activated_generation=NULL,
               ingestion_blocked_reason='shopify_customer_redaction'
          FROM jsonb_array_elements(resolved_targets) AS target(item)
         WHERE connection.tenant_id=target.item->>'tenantId'
           AND connection.connection_id=target.item->>'connectionId'
           AND connection.connection_generation=
               (target.item->>'connectionGeneration')::bigint
           AND connection.connector_key='shopify'
           AND lower(connection.external_account_reference)=
               document->>'shopDomain';
        UPDATE control_plane.readiness AS readiness
           SET state='blocked',reason_code='shopify_customer_redaction',
               reason_detail='Shopify requested customer data redaction; the connection is fenced pending verified erasure.',
               evaluated_at=requested_at
          FROM jsonb_array_elements(resolved_targets) AS target(item)
         WHERE readiness.tenant_id=target.item->>'tenantId'
           AND readiness.connection_id=target.item->>'connectionId';
      END IF;
      dispatched_status:='dispatched';
    ELSE
      -- Preserve the authenticated receipt for operator reconciliation. A
      -- message without an Albert target would be unactionable and must not be
      -- represented as dispatched.
      dispatched_status:='unresolved';
    END IF;
  ELSE
    -- Re-select the now-locked target rows for lifecycle deletion. Ingestion
    -- activation is irrelevant: deletion must work before Start.
    FOR candidate IN
      SELECT connection.*
      FROM control_plane.connections AS connection
      WHERE connection.connector_key='shopify'
        AND lower(connection.external_account_reference)=document->>'shopDomain'
        AND connection.status IN ('connected','degraded','disconnected')
      ORDER BY connection.tenant_id,connection.connection_id
      FOR UPDATE
    LOOP
      SELECT request.deletion_request_id INTO generated_request_id
        FROM control_plane.deletion_requests AS request
       WHERE request.tenant_id=candidate.tenant_id
         AND request.connection_id=candidate.connection_id
         AND request.scope='connection'
         AND request.status IN ('queued','running','retry_wait','verifying','failed')
       ORDER BY request.requested_at DESC
       LIMIT 1
       FOR UPDATE;
      IF generated_request_id IS NULL THEN
        generated_request_id:=control_plane.generate_ulid();
        INSERT INTO control_plane.deletion_requests (
          tenant_id,deletion_request_id,connection_id,scope,status,requested_by,
          remote_revocation_status,credential_destroyed_at,
          credential_destruction_due_at,purge_due_at,progress,requested_at
        ) VALUES (
          candidate.tenant_id,generated_request_id,candidate.connection_id,
          'connection','queued',NULL,'unsupported',NULL,
          requested_at+interval '15 minutes',requested_at,
          jsonb_build_object(
            'shopify_lifecycle',jsonb_build_object(
              'inboxId',generated_inbox_id,
              'topic',document->>'topic',
              'receivedAt',requested_at,
              'signatureVerified',true
            )
          ),requested_at
        );
        PERFORM control_plane.enqueue_deletion_request(generated_request_id);
      ELSIF EXISTS (
        SELECT 1 FROM control_plane.deletion_requests AS request
        WHERE request.tenant_id=candidate.tenant_id
          AND request.deletion_request_id=generated_request_id
          AND request.status IN ('queued','retry_wait','failed')
          AND request.queue_message_id IS NULL
      ) THEN
        PERFORM control_plane.enqueue_deletion_request(generated_request_id);
      END IF;

      -- Fence OAuth/scheduler/webhook producers in the same transaction as
      -- durable deletion publication. This can only remove authority; it does
      -- not request Shopify data or enqueue any sync job.
      DELETE FROM control_plane.deputy_webhook_material
       WHERE tenant_id=candidate.tenant_id AND connection_id=candidate.connection_id;
      UPDATE control_plane.connections AS connection
         SET status='disconnected',auth_health='revoked',disconnected_at=requested_at,
             ingestion_activated_at=NULL,ingestion_activated_by=NULL,
             ingestion_activated_generation=NULL,
             ingestion_blocked_reason='shopify_lifecycle_deletion'
       WHERE connection.tenant_id=candidate.tenant_id
         AND connection.connection_id=candidate.connection_id;
      UPDATE control_plane.readiness
         SET state='blocked',reason_code='connection_disconnected',
             reason_detail='Shopify requested lifecycle or compliance deletion.',
             evaluated_at=requested_at
       WHERE tenant_id=candidate.tenant_id AND connection_id=candidate.connection_id;
      deletion_ids:=array_append(deletion_ids,generated_request_id);
      generated_request_id:=NULL;
    END LOOP;
    dispatched_status:=CASE WHEN targets>0 THEN 'dispatched' ELSE 'unresolved' END;
  END IF;

  INSERT INTO control_plane.shopify_compliance_inbox (
    inbox_id,webhook_id,event_id,topic,shop_reference_hmac,shop_id,
    body_sha256,api_version,customer_reference,customer_contact_hmac,
    order_references,data_request_reference,status,target_count,
    privacy_queue_message_id,deletion_request_ids,received_at
  ) VALUES (
    generated_inbox_id,document->>'webhookId',document->>'eventId',
    document->>'topic',document->>'shopReferenceHmac',document->>'shopId',
    document->>'bodySha256',document->>'apiVersion',customer_reference,
    customer_contact_hmac,orders,data_request_reference,dispatched_status,
    targets,generated_message_id,deletion_ids,requested_at
  );
  INSERT INTO control_plane.shopify_compliance_targets (
    inbox_id,tenant_id,connection_id,connection_generation
  )
  SELECT generated_inbox_id,item->>'tenantId',item->>'connectionId',
         (item->>'connectionGeneration')::bigint
  FROM jsonb_array_elements(resolved_targets) AS target(item);
  RETURN QUERY SELECT generated_inbox_id,dispatched_status,false,targets;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_shopify_compliance_webhook_ready()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,pgmq
AS $$
BEGIN
  IF to_regclass('control_plane.shopify_compliance_inbox') IS NULL
     OR to_regclass('control_plane.shopify_compliance_targets') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pgmq.meta WHERE queue_name='albert_shopify_privacy'
     )
     OR to_regprocedure(
       'control_plane.accept_attested_shopify_compliance_webhook(text,bigint,text,text,text)'
     ) IS NULL THEN
    RAISE EXCEPTION 'Shopify compliance webhook boundary is not ready'
      USING ERRCODE='55000';
  END IF;
END;
$$;

COMMENT ON FUNCTION control_plane.accept_attested_shopify_compliance_webhook(
  text,bigint,text,text,text
) IS
  'Consumes a one-use gateway proof after Shopify raw-body HMAC verification. Customer privacy work is durably claimed by the dedicated least-privilege privacy consumer in the deletion worker; shop lifecycle work atomically fences the connection and enters the same verified deletion runtime. It never enqueues ingestion or persists the source payload. Official source: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance';

REVOKE ALL ON FUNCTION control_plane.accept_attested_shopify_compliance_webhook(
  text,bigint,text,text,text
) FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_webhook_control,albert_transform_control,albert_semantic_control,
       albert_operator_diagnostic_control,albert_deletion_control;
GRANT EXECUTE ON FUNCTION control_plane.accept_attested_shopify_compliance_webhook(
  text,bigint,text,text,text
) TO albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.assert_shopify_compliance_webhook_ready()
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;
GRANT EXECUTE ON FUNCTION control_plane.assert_shopify_compliance_webhook_ready()
TO albert_webhook_control;

COMMIT;
