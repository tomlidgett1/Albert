\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.webhook_test_signature(
  p_operation text,
  p_subject text,
  p_document text,
  p_issued_at bigint,
  p_nonce text
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT encode(
    extensions.hmac(
      convert_to(
        concat_ws(E'\n','albert:webhook-attestation:v1',p_operation,p_subject,
          encode(extensions.digest(convert_to(p_document,'UTF8'),'sha256'),'hex'),
          p_issued_at::text,p_nonce),
        'UTF8'
      ),
      decode(repeat('0b',32),'hex'),
      'sha256'
    ),
    'hex'
  );
$$;
REVOKE ALL ON FUNCTION pg_temp.webhook_test_signature(text,text,text,bigint,text)
  FROM PUBLIC, albert_webhook_control;

SELECT control_plane.install_webhook_attestation_key(
  'sql-webhook-v1',decode(repeat('0b',32),'hex')
);

CREATE TEMP TABLE webhook_test_proofs (
  name text PRIMARY KEY,
  document text NOT NULL,
  issued_at bigint NOT NULL,
  nonce text NOT NULL,
  signature text NOT NULL
) ON COMMIT DROP;
GRANT SELECT ON webhook_test_proofs TO albert_webhook_control;

WITH challenge AS (
  SELECT jsonb_build_object(
    'version',1,'operation','system.ready','attestationKeyId','sql-webhook-v1',
    'deputyKeyIds',jsonb_build_array('sql-deputy-v1')
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'AAAAAAAAAAAAAAAAAAAAAA'::text AS nonce
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'ready',document,issued_at,nonce,
       pg_temp.webhook_test_signature(
         'system.ready','sql-webhook-v1',document,issued_at,nonce
       )
FROM challenge;

SET LOCAL ROLE albert_webhook_control;
SELECT control_plane.assert_attested_webhook_gateway_ready(
  document,issued_at,nonce,'sql-webhook-v1',signature
)
FROM webhook_test_proofs WHERE name='ready';

DO $$
BEGIN
  BEGIN
    PERFORM control_plane.assert_attested_webhook_gateway_ready(
      proof.document,proof.issued_at,proof.nonce,'sql-webhook-v1',proof.signature
    ) FROM pg_temp.webhook_test_proofs AS proof WHERE proof.name='ready';
    RAISE EXCEPTION 'one-use readiness challenge replay was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%already consumed%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM control_plane.assert_attested_webhook_gateway_ready(
      proof.document,proof.issued_at,'BBBBBBBBBBBBBBBBBBBBBB','sql-webhook-v1',repeat('0',64)
    ) FROM pg_temp.webhook_test_proofs AS proof WHERE proof.name='ready';
    RAISE EXCEPTION 'readiness accepted a key id with the wrong secret';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%signature is invalid%' THEN RAISE; END IF;
  END;
END;
$$;
RESET ROLE;

-- Deputy material resolution and receipt mutation are proof-gated too. The
-- concrete return call catches drift between the wrapper's table signature and
-- the owner-only legacy resolver, while attach/fail prove exact receipt and
-- active-material binding.
INSERT INTO control_plane.tenants(tenant_id,slug,display_name)
VALUES ('01J00000000000000000000040','webhook-sql-deputy','Webhook SQL Deputy');
INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,
  external_account_reference,status,auth_health,authorised_at
) VALUES (
  '01J00000000000000000000040','01J00000000000000000000041','deputy',
  'Webhook SQL Deputy','deputy-account-sql','connected','healthy',clock_timestamp()
);
INSERT INTO control_plane.deputy_webhook_material(
  tenant_id,connection_id,material_id,verification_mode,key_id,iv,ciphertext,
  callback_url,setup_status,required_topics
) VALUES (
  '01J00000000000000000000040','01J00000000000000000000041',
  '01J00000000000000000000042','custom_header','sql-deputy-v1',repeat('A',16),
  repeat('B',64),'https://hooks.albert.invalid/v1/webhooks/deputy/sql',
  'installation_required',ARRAY['employees']::text[]
);

WITH prepared AS (
  SELECT jsonb_build_object(
    'version',1,'operation','deputy.resolve',
    'connectionId','01J00000000000000000000041',
    'materialId','01J00000000000000000000042'
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'HHHHHHHHHHHHHHHHHHHHHH'::text AS nonce
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'deputy-resolve',document,issued_at,nonce,
       pg_temp.webhook_test_signature(
         'deputy.resolve','01J00000000000000000000041',document,issued_at,nonce
       )
FROM prepared;

SET LOCAL ROLE albert_webhook_control;
SELECT resolved.connection_id,resolved.material_id,resolved.envelope_version,resolved.key_id
FROM webhook_test_proofs AS proof
CROSS JOIN LATERAL control_plane.resolve_attested_deputy_webhook_material(
  proof.document,proof.issued_at,proof.nonce,'sql-webhook-v1',proof.signature
) AS resolved
WHERE proof.name='deputy-resolve';
RESET ROLE;

WITH challenge AS (
  SELECT jsonb_build_object(
    'version',1,'operation','system.ready','attestationKeyId','sql-webhook-v1',
    'deputyKeyIds',jsonb_build_array('sql-deputy-v1')
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'IIIIIIIIIIIIIIIIIIIIII'::text AS nonce
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'ready-with-material',document,issued_at,nonce,
       pg_temp.webhook_test_signature(
         'system.ready','sql-webhook-v1',document,issued_at,nonce
       )
FROM challenge;

SET LOCAL ROLE albert_webhook_control;
SELECT control_plane.assert_attested_webhook_gateway_ready(
  document,issued_at,nonce,'sql-webhook-v1',signature
)
FROM webhook_test_proofs WHERE name='ready-with-material';
RESET ROLE;

WITH prepared AS (
  SELECT
    date_trunc('milliseconds',clock_timestamp()) AS received_at,
    floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
    'JJJJJJJJJJJJJJJJJJJJJJ'::text AS nonce
), document AS (
  SELECT jsonb_build_object(
    'version',1,'operation','receipt.reserve',
    'tenantId','01J00000000000000000000040',
    'connectionId','01J00000000000000000000041','connectorKey','deputy',
    'verificationReference','01J00000000000000000000042',
    'leaseOwner',NULL,'leaseToken',NULL,'leaseVersion',NULL,
    'receiptId','01J00000000000000000000043','dedupeKey','deputy:sql:event-1',
    'vendorEventId','event-1','bodySha256',repeat('4',64),
    'safeHeaders',jsonb_build_object('content-type','application/json'),
    'receivedAt',to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::text AS document,issued_at,nonce
  FROM prepared
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'deputy-reserve',document,issued_at,nonce,
       pg_temp.webhook_test_signature(
         'receipt.reserve','01J00000000000000000000043',document,issued_at,nonce
       )
FROM document;

SET LOCAL ROLE albert_webhook_control;
SELECT reserved.webhook_receipt_id,reserved.status
FROM webhook_test_proofs AS proof
CROSS JOIN LATERAL control_plane.reserve_attested_webhook_receipt(
  proof.document,proof.issued_at,proof.nonce,'sql-webhook-v1',proof.signature,
  '01J00000000000000000000043'
) AS reserved
WHERE proof.name='deputy-reserve';
RESET ROLE;

WITH receipt AS (
  SELECT item.received_at,
    concat_ws('/','tenant',item.tenant_id,'connection',item.connection_id,
      'stream','webhook_deputy','date',
      to_char(item.received_at AT TIME ZONE 'UTC','YYYY-MM-DD'),
      'batch-'||item.webhook_receipt_id||'.json.gz') AS object_key
  FROM control_plane.webhook_receipts AS item
  WHERE item.tenant_id='01J00000000000000000000040'
    AND item.webhook_receipt_id='01J00000000000000000000043'
), prepared AS (
  SELECT jsonb_build_object(
    'version',1,'operation','receipt.attach',
    'tenantId','01J00000000000000000000040',
    'connectionId','01J00000000000000000000041','connectorKey','deputy',
    'verificationReference','01J00000000000000000000042',
    'leaseOwner',NULL,'leaseToken',NULL,'leaseVersion',NULL,
    'receiptId','01J00000000000000000000043','objectKey',object_key
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'KKKKKKKKKKKKKKKKKKKKKK'::text AS nonce
  FROM receipt
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'deputy-attach',document,issued_at,nonce,
       pg_temp.webhook_test_signature(
         'receipt.attach','01J00000000000000000000043',document,issued_at,nonce
       )
FROM prepared;

SET LOCAL ROLE albert_webhook_control;
SELECT control_plane.attach_attested_webhook_raw(
  document,issued_at,nonce,'sql-webhook-v1',signature
)
FROM webhook_test_proofs WHERE name='deputy-attach';
RESET ROLE;

WITH prepared AS (
  SELECT jsonb_build_object(
    'version',1,'operation','receipt.fail',
    'tenantId','01J00000000000000000000040',
    'connectionId','01J00000000000000000000041','connectorKey','deputy',
    'verificationReference','01J00000000000000000000042',
    'leaseOwner',NULL,'leaseToken',NULL,'leaseVersion',NULL,
    'receiptId','01J00000000000000000000043'
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'LLLLLLLLLLLLLLLLLLLLLL'::text AS nonce
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'deputy-fail',document,issued_at,nonce,
       pg_temp.webhook_test_signature(
         'receipt.fail','01J00000000000000000000043',document,issued_at,nonce
       )
FROM prepared;

SET LOCAL ROLE albert_webhook_control;
SELECT control_plane.fail_attested_webhook_receipt(
  document,issued_at,nonce,'sql-webhook-v1',signature
)
FROM webhook_test_proofs WHERE name='deputy-fail';
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.webhook_receipts
     WHERE tenant_id='01J00000000000000000000040'
       AND webhook_receipt_id='01J00000000000000000000043'
       AND status='failed' AND signature_verified AND raw_object_key IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Deputy proof-gated reserve/attach/fail lifecycle was not durable';
  END IF;
END;
$$;

WITH values AS (
  SELECT
    '01J00000000000000000000030'::text AS inbox_id,
    decode(repeat('01',12),'hex') AS encryption_nonce,
    decode(repeat('02',32),'hex') AS ciphertext,
    decode(repeat('03',16),'hex') AS auth_tag,
    date_trunc('milliseconds',clock_timestamp()) AS received_at
), prepared AS (
  SELECT values.*,
    jsonb_build_object(
      'version',1,'operation','xero.accept','inboxId',inbox_id,
      'bodySha256',repeat('1',64),'encryptionKeyId','sql-inbox-v1',
      'nonceHex',encode(encryption_nonce,'hex'),
      'ciphertextSha256',encode(extensions.digest(ciphertext,'sha256'),'hex'),
      'authTagHex',encode(auth_tag,'hex'),'bodyBytes',octet_length(ciphertext),
      'firstEventSequence',1,'lastEventSequence',1,'eventCount',1,
      'receivedAt',to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'expiresAt',to_char((received_at+interval '3 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'retainUntil',to_char((received_at+interval '14 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )::text AS document,
    floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
    'CCCCCCCCCCCCCCCCCCCCCC'::text AS proof_nonce
  FROM values
), proof AS (
  INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
  SELECT 'accept',document,issued_at,proof_nonce,
         pg_temp.webhook_test_signature('xero.accept',inbox_id,document,issued_at,proof_nonce)
  FROM prepared
  RETURNING document,issued_at,nonce,signature
)
SELECT * FROM proof;

SET LOCAL ROLE albert_webhook_control;
SELECT accepted.inbox_id,accepted.status,accepted.created,accepted.delivery_count
FROM webhook_test_proofs AS proof
CROSS JOIN LATERAL control_plane.accept_attested_xero_webhook_inbox(
  proof.document,proof.issued_at,proof.nonce,'sql-webhook-v1',proof.signature,
  decode(repeat('01',12),'hex'),decode(repeat('02',32),'hex'),decode(repeat('03',16),'hex')
) AS accepted
WHERE proof.name='accept';
RESET ROLE;

WITH prepared AS (
  SELECT jsonb_build_object(
    'version',1,'operation','xero.claim','workerId','webhook-sql:replica-a',
    'limit',1,'leaseSeconds',90
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'DDDDDDDDDDDDDDDDDDDDDD'::text AS nonce
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'claim',document,issued_at,nonce,
       pg_temp.webhook_test_signature(
         'xero.claim','webhook-sql:replica-a',document,issued_at,nonce
       )
FROM prepared;

CREATE TEMP TABLE webhook_test_claim (
  inbox_id text,lease_token text,lease_version bigint
) ON COMMIT DROP;
GRANT INSERT ON webhook_test_claim TO albert_webhook_control;

SET LOCAL ROLE albert_webhook_control;
INSERT INTO webhook_test_claim(inbox_id,lease_token,lease_version)
SELECT claimed.inbox_id,claimed.lease_token,claimed.lease_version
FROM webhook_test_proofs AS proof
CROSS JOIN LATERAL control_plane.claim_attested_xero_webhook_inbox(
  proof.document,proof.issued_at,proof.nonce,'sql-webhook-v1',proof.signature
) AS claimed
WHERE proof.name='claim';
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_temp.webhook_test_claim
     WHERE inbox_id='01J00000000000000000000030'
       AND lease_token~'^[A-Za-z0-9_-]{22}$' AND lease_version=1
  ) THEN
    RAISE EXCEPTION 'claim did not return a DB-generated token and monotonic version';
  END IF;
END;
$$;

WITH prepared AS (
  SELECT jsonb_build_object(
    'version',1,'operation','xero.sequence','inboxId',claim.inbox_id,
    'workerId','webhook-sql:replica-a','leaseToken','ZZZZZZZZZZZZZZZZZZZZZZ',
    'leaseVersion',claim.lease_version
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'EEEEEEEEEEEEEEEEEEEEEE'::text AS nonce,
  claim.inbox_id
  FROM webhook_test_claim AS claim
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'stale-sequence',document,issued_at,nonce,
       pg_temp.webhook_test_signature('xero.sequence',inbox_id,document,issued_at,nonce)
FROM prepared;

SET LOCAL ROLE albert_webhook_control;
DO $$
BEGIN
  BEGIN
    PERFORM control_plane.record_attested_xero_webhook_sequence(
      proof.document,proof.issued_at,proof.nonce,'sql-webhook-v1',proof.signature
    ) FROM pg_temp.webhook_test_proofs AS proof WHERE proof.name='stale-sequence';
    RAISE EXCEPTION 'a signed document with the wrong lease token mutated Xero state';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM NOT LIKE '%lease fence is not owned%' THEN RAISE; END IF;
  END;
END;
$$;
RESET ROLE;

WITH prepared AS (
  SELECT jsonb_build_object(
    'version',1,'operation','xero.sequence','inboxId',claim.inbox_id,
    'workerId','webhook-sql:replica-a','leaseToken',claim.lease_token,
    'leaseVersion',claim.lease_version
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'FFFFFFFFFFFFFFFFFFFFFF'::text AS nonce,
  claim.inbox_id
  FROM webhook_test_claim AS claim
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'sequence',document,issued_at,nonce,
       pg_temp.webhook_test_signature('xero.sequence',inbox_id,document,issued_at,nonce)
FROM prepared;

SET LOCAL ROLE albert_webhook_control;
SELECT observed.disposition,observed.gap_id
FROM webhook_test_proofs AS proof
CROSS JOIN LATERAL control_plane.record_attested_xero_webhook_sequence(
  proof.document,proof.issued_at,proof.nonce,'sql-webhook-v1',proof.signature
) AS observed
WHERE proof.name='sequence';
RESET ROLE;

INSERT INTO control_plane.tenants(tenant_id,slug,display_name)
VALUES ('01J00000000000000000000050','webhook-sql-xero','Webhook SQL Xero');
INSERT INTO control_plane.connections(
  tenant_id,connection_id,connector_key,display_name,
  external_account_reference,status,auth_health,authorised_at
) VALUES (
  '01J00000000000000000000050','01J00000000000000000000051','xero',
  'Webhook SQL Xero','xero-account-sql','connected','healthy',clock_timestamp()
);

WITH prepared AS (
  SELECT jsonb_build_object(
    'version',1,'operation','xero.resolve',
    'externalAccountReferences',jsonb_build_array('xero-account-sql')
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'MMMMMMMMMMMMMMMMMMMMMM'::text AS nonce
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'xero-resolve',document,issued_at,nonce,
       pg_temp.webhook_test_signature(
         'xero.resolve','xero-connections',document,issued_at,nonce
       )
FROM prepared;

SET LOCAL ROLE albert_webhook_control;
SELECT resolved.tenant_id,resolved.connection_id,resolved.external_account_reference
FROM webhook_test_proofs AS proof
CROSS JOIN LATERAL control_plane.resolve_attested_xero_webhook_connections(
  proof.document,proof.issued_at,proof.nonce,'sql-webhook-v1',proof.signature
) AS resolved
WHERE proof.name='xero-resolve';
RESET ROLE;

WITH prepared AS (
  SELECT jsonb_build_object(
    'version',1,'operation','xero.renew','inboxId',claim.inbox_id,
    'workerId','webhook-sql:replica-a','leaseToken',claim.lease_token,
    'leaseVersion',claim.lease_version,'leaseSeconds',90
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'NNNNNNNNNNNNNNNNNNNNNN'::text AS nonce,
  claim.inbox_id
  FROM webhook_test_claim AS claim
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'renew',document,issued_at,nonce,
       pg_temp.webhook_test_signature('xero.renew',inbox_id,document,issued_at,nonce)
FROM prepared;

SET LOCAL ROLE albert_webhook_control;
SELECT control_plane.renew_attested_xero_webhook_inbox_lease(
  document,issued_at,nonce,'sql-webhook-v1',signature
)
FROM webhook_test_proofs WHERE name='renew';
RESET ROLE;

WITH prepared AS (
  SELECT claim.*,
    to_char(inbox.first_received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      AS received_at,
    jsonb_build_object(
      'version',1,'operation','receipt.reserve',
      'tenantId','01J00000000000000000000050',
      'connectionId','01J00000000000000000000051','connectorKey','xero',
      'verificationReference',claim.inbox_id,'leaseOwner','webhook-sql:replica-a',
      'leaseToken',claim.lease_token,'leaseVersion',claim.lease_version,
      'receiptId','01J00000000000000000000052',
      'dedupeKey','xero:'||claim.inbox_id||':invoices','vendorEventId',claim.inbox_id,
      'bodySha256',repeat('5',64),
      'safeHeaders',jsonb_build_object(
        'source_body_sha256',inbox.body_sha256,'inbox_key_id',inbox.encryption_key_id
      ),
      'receivedAt',to_char(
        inbox.first_received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    )::text AS document,
    floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
    'OOOOOOOOOOOOOOOOOOOOOO'::text AS nonce
  FROM webhook_test_claim AS claim
  JOIN control_plane.xero_webhook_inbox AS inbox ON inbox.inbox_id=claim.inbox_id
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'xero-reserve',document,issued_at,nonce,
       pg_temp.webhook_test_signature(
         'receipt.reserve','01J00000000000000000000052',document,issued_at,nonce
       )
FROM prepared;

SET LOCAL ROLE albert_webhook_control;
SELECT reserved.webhook_receipt_id,reserved.status
FROM webhook_test_proofs AS proof
CROSS JOIN LATERAL control_plane.reserve_attested_webhook_receipt(
  proof.document,proof.issued_at,proof.nonce,'sql-webhook-v1',proof.signature,
  '01J00000000000000000000052'
) AS reserved
WHERE proof.name='xero-reserve';
RESET ROLE;

WITH prepared AS (
  SELECT claim.*,
    concat_ws('/','tenant','01J00000000000000000000050','connection',
      '01J00000000000000000000051','stream','webhook_xero','date',
      to_char(receipt.received_at AT TIME ZONE 'UTC','YYYY-MM-DD'),
      'batch-01J00000000000000000000052.json.gz') AS object_key
  FROM webhook_test_claim AS claim
  JOIN control_plane.webhook_receipts AS receipt
    ON receipt.webhook_receipt_id='01J00000000000000000000052'
), document AS (
  SELECT jsonb_build_object(
    'version',1,'operation','receipt.attach',
    'tenantId','01J00000000000000000000050',
    'connectionId','01J00000000000000000000051','connectorKey','xero',
    'verificationReference',inbox_id,'leaseOwner','webhook-sql:replica-a',
    'leaseToken',lease_token,'leaseVersion',lease_version,
    'receiptId','01J00000000000000000000052','objectKey',object_key
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'PPPPPPPPPPPPPPPPPPPPPP'::text AS nonce
  FROM prepared
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'xero-attach',document,issued_at,nonce,
       pg_temp.webhook_test_signature(
         'receipt.attach','01J00000000000000000000052',document,issued_at,nonce
       )
FROM document;

SET LOCAL ROLE albert_webhook_control;
SELECT control_plane.attach_attested_webhook_raw(
  document,issued_at,nonce,'sql-webhook-v1',signature
)
FROM webhook_test_proofs WHERE name='xero-attach';
RESET ROLE;

WITH prepared AS (
  SELECT claim.*,
    to_char(receipt.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      AS received_at
  FROM webhook_test_claim AS claim
  JOIN control_plane.webhook_receipts AS receipt
    ON receipt.webhook_receipt_id='01J00000000000000000000052'
), document AS (
  SELECT jsonb_build_object(
    'version',1,'operation','xero.enqueue',
    'tenantId','01J00000000000000000000050',
    'connectionId','01J00000000000000000000051','inboxId',inbox_id,
    'workerId','webhook-sql:replica-a','leaseToken',lease_token,
    'leaseVersion',lease_version,'receiptId','01J00000000000000000000052',
    'stream','invoices','receivedAt',received_at
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'QQQQQQQQQQQQQQQQQQQQQQ'::text AS nonce
  FROM prepared
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'xero-enqueue',document,issued_at,nonce,
       pg_temp.webhook_test_signature(
         'xero.enqueue','01J00000000000000000000052',document,issued_at,nonce
       )
FROM document;

SET LOCAL ROLE albert_webhook_control;
SELECT control_plane.enqueue_attested_xero_webhook_incremental(
  document,issued_at,nonce,'sql-webhook-v1',signature
)
FROM webhook_test_proofs WHERE name='xero-enqueue';
RESET ROLE;

WITH prepared AS (
  SELECT jsonb_build_object(
    'version',1,'operation','xero.connection',
    'tenantId','01J00000000000000000000050',
    'connectionId','01J00000000000000000000051','inboxId',claim.inbox_id,
    'workerId','webhook-sql:replica-a','leaseToken',claim.lease_token,
    'leaseVersion',claim.lease_version,'streams',jsonb_build_array('invoices')
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'RRRRRRRRRRRRRRRRRRRRRR'::text AS nonce,
  claim.inbox_id
  FROM webhook_test_claim AS claim
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'xero-connection',document,issued_at,nonce,
       pg_temp.webhook_test_signature('xero.connection',inbox_id,document,issued_at,nonce)
FROM prepared;

SET LOCAL ROLE albert_webhook_control;
SELECT delivered.created,delivered.disposition
FROM webhook_test_proofs AS proof
CROSS JOIN LATERAL control_plane.record_attested_xero_webhook_connection_delivery(
  proof.document,proof.issued_at,proof.nonce,'sql-webhook-v1',proof.signature
) AS delivered
WHERE proof.name='xero-connection';
RESET ROLE;

WITH prepared AS (
  SELECT jsonb_build_object(
    'version',1,'operation','xero.complete','inboxId',claim.inbox_id,
    'workerId','webhook-sql:replica-a','leaseToken',claim.lease_token,
    'leaseVersion',claim.lease_version,
    'summary',jsonb_build_object(
      'partitionCount',1,'matchedConnectionCount',1,'routedStreamCount',1,
      'unmatchedPartitionCount',0,'ignoredEventCount',0,
      'sequenceDisposition','initial','gapRecoveryCount',0
    )
  )::text AS document,
  floor(extract(epoch FROM clock_timestamp()))::bigint AS issued_at,
  'GGGGGGGGGGGGGGGGGGGGGG'::text AS nonce,
  claim.inbox_id
  FROM webhook_test_claim AS claim
)
INSERT INTO webhook_test_proofs(name,document,issued_at,nonce,signature)
SELECT 'complete',document,issued_at,nonce,
       pg_temp.webhook_test_signature('xero.complete',inbox_id,document,issued_at,nonce)
FROM prepared;

SET LOCAL ROLE albert_webhook_control;
SELECT control_plane.complete_attested_xero_webhook_inbox(
  proof.document,proof.issued_at,proof.nonce,'sql-webhook-v1',proof.signature
)
FROM webhook_test_proofs AS proof WHERE proof.name='complete';
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.xero_webhook_inbox
     WHERE inbox_id='01J00000000000000000000030' AND status='processed'
       AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
       AND ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL
       AND lease_version=1
  ) THEN
    RAISE EXCEPTION 'completion did not atomically erase ciphertext and clear the lease fence';
  END IF;
END;
$$;

DO $$
BEGIN
  IF has_function_privilege(
       'albert_webhook_control','control_plane.claim_xero_webhook_inbox(text,integer,integer)','EXECUTE'
     ) OR has_function_privilege(
       'albert_webhook_control','control_plane.resolve_deputy_webhook_material(text,text)','EXECUTE'
     ) OR has_function_privilege(
       'albert_webhook_control','control_plane.attach_attested_webhook_raw(text,text,text,text)','EXECUTE'
     ) THEN
    RAISE EXCEPTION 'the webhook runtime retained a legacy proof-bypass RPC';
  END IF;
END;
$$;

ROLLBACK;
