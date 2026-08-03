BEGIN;

-- A leaked public-edge database credential must not be sufficient to resolve
-- verifier material, accept an inbox body, claim work, mutate a receipt, or
-- fan out sync jobs. 0037 introduced independently keyed one-use proofs; this
-- migration makes those proofs the only runtime path through the complete
-- webhook lifecycle and fences every Xero mutation to one concrete lease.

ALTER TABLE control_plane.xero_webhook_inbox
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS lease_version bigint NOT NULL DEFAULT 0;

-- A deployment that introduces fencing cannot safely preserve an in-flight
-- lease because the old worker never received its token. Requeue it
-- immediately; the first proof-gated claimant receives a fresh token/version.
UPDATE control_plane.xero_webhook_inbox
   SET status = 'retry_wait',
       lease_owner = NULL,
       lease_expires_at = NULL,
       lease_token = NULL,
       next_attempt_at = least(next_attempt_at, clock_timestamp()),
       last_error_code = 'lease_fence_upgrade'
 WHERE status = 'processing';

ALTER TABLE control_plane.xero_webhook_inbox
  DROP CONSTRAINT IF EXISTS xero_webhook_inbox_lease_fence_check,
  ADD CONSTRAINT xero_webhook_inbox_lease_fence_check CHECK (
    lease_version >= 0
    AND (
      (
        status = 'processing'
        AND lease_token ~ '^[A-Za-z0-9_-]{22}$'
        AND lease_version > 0
      )
      OR (status <> 'processing' AND lease_token IS NULL)
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS xero_webhook_inbox_live_lease_token_uidx
  ON control_plane.xero_webhook_inbox(lease_token)
  WHERE lease_token IS NOT NULL;

CREATE OR REPLACE FUNCTION control_plane.webhook_document_has_exact_keys(
  p_document jsonb,
  p_keys text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT jsonb_typeof(p_document) = 'object'
     AND cardinality(p_keys) = (
       SELECT count(*)::integer FROM jsonb_object_keys(p_document)
     )
     AND p_document ?& p_keys
     AND cardinality(p_keys) = (
       SELECT count(DISTINCT expected.key)::integer
         FROM unnest(p_keys) AS expected(key)
     );
$$;

CREATE OR REPLACE FUNCTION control_plane.webhook_document_integer(
  p_document jsonb,
  p_key text,
  p_minimum bigint,
  p_maximum bigint
)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  encoded text;
  parsed bigint;
BEGIN
  IF jsonb_typeof(p_document -> p_key) <> 'number' THEN
    RAISE EXCEPTION 'webhook attestation integer field is invalid' USING ERRCODE = '22023';
  END IF;
  encoded := p_document ->> p_key;
  IF encoded !~ '^(0|[1-9][0-9]{0,18})$' THEN
    RAISE EXCEPTION 'webhook attestation integer field is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    parsed := encoded::bigint;
  EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION 'webhook attestation integer field is invalid' USING ERRCODE = '22023';
  END;
  IF parsed NOT BETWEEN p_minimum AND p_maximum THEN
    RAISE EXCEPTION 'webhook attestation integer field is invalid' USING ERRCODE = '22023';
  END IF;
  RETURN parsed;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.webhook_document_timestamp(
  p_document jsonb,
  p_key text
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  encoded text;
  parsed timestamptz;
BEGIN
  IF jsonb_typeof(p_document -> p_key) <> 'string' THEN
    RAISE EXCEPTION 'webhook attestation timestamp field is invalid' USING ERRCODE = '22023';
  END IF;
  encoded := p_document ->> p_key;
  IF encoded !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
    RAISE EXCEPTION 'webhook attestation timestamp field is invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    parsed := encoded::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'webhook attestation timestamp field is invalid' USING ERRCODE = '22023';
  END;
  RETURN parsed;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_xero_webhook_lease_fence(
  p_inbox_id text,
  p_worker_id text,
  p_lease_token text,
  p_lease_version bigint
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT control_plane.is_ulid(p_inbox_id)
     OR p_worker_id IS NULL
     OR p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR p_lease_token IS NULL
     OR p_lease_token !~ '^[A-Za-z0-9_-]{22}$'
     OR p_lease_version IS NULL
     OR p_lease_version < 1 THEN
    RAISE EXCEPTION 'xero webhook lease fence is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM 1
    FROM control_plane.xero_webhook_inbox AS inbox
   WHERE inbox.inbox_id = p_inbox_id
     AND inbox.status = 'processing'
     AND inbox.lease_owner = p_worker_id
     AND inbox.lease_token = p_lease_token
     AND inbox.lease_version = p_lease_version
     AND inbox.lease_expires_at > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'xero webhook lease fence is not owned' USING ERRCODE = '55000';
  END IF;
END;
$$;

-- Serialize the bounded key ring. Row locks alone do not serialize installs
-- of distinct IDs or concurrent retirement of the final two active keys.
CREATE OR REPLACE FUNCTION control_plane.install_webhook_attestation_key(
  p_key_id text,
  p_secret bytea
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  existing bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('albert:webhook-attestation:key-ring', 0)
  );
  IF p_key_id IS NULL
     OR p_key_id !~ '^[a-z][a-z0-9._-]{0,63}$'
     OR p_secret IS NULL
     OR octet_length(p_secret) <> 32 THEN
    RAISE EXCEPTION 'webhook attestation key is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT key.secret_key INTO existing
    FROM control_plane.webhook_attestation_keys AS key
   WHERE key.key_id = p_key_id
   FOR UPDATE;
  IF FOUND AND existing IS DISTINCT FROM p_secret THEN
    RAISE EXCEPTION 'webhook attestation key id already has different material'
      USING ERRCODE = '22000';
  END IF;
  INSERT INTO control_plane.webhook_attestation_keys(key_id, secret_key, active)
  VALUES (p_key_id, p_secret, true)
  ON CONFLICT (key_id) DO UPDATE
    SET active = true,
        retired_at = NULL;
  IF (SELECT count(*) FROM control_plane.webhook_attestation_keys WHERE active) > 3 THEN
    RAISE EXCEPTION 'at most three webhook attestation keys may be active'
      USING ERRCODE = '54000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.retire_webhook_attestation_key(p_key_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('albert:webhook-attestation:key-ring', 0)
  );
  UPDATE control_plane.webhook_attestation_keys
     SET active = false,
         retired_at = clock_timestamp()
   WHERE key_id = p_key_id
     AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active webhook attestation key was not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control_plane.webhook_attestation_keys WHERE active) THEN
    RAISE EXCEPTION 'at least one webhook attestation key must remain active'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.accept_attested_xero_webhook_inbox(
  p_document text,
  p_issued_at bigint,
  p_nonce text,
  p_key_id text,
  p_signature text,
  p_encryption_nonce bytea,
  p_ciphertext bytea,
  p_auth_tag bytea
)
RETURNS TABLE (
  inbox_id text,
  status text,
  created boolean,
  delivery_count integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  document jsonb;
  body_bytes integer;
  first_sequence integer;
  last_sequence integer;
  event_count integer;
  received_at timestamptz;
  expires_at timestamptz;
  retain_until timestamptz;
BEGIN
  BEGIN
    document := p_document::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'xero webhook acceptance document is invalid' USING ERRCODE = '22023';
  END;
  document := control_plane.consume_webhook_attestation(
    'xero.accept', document ->> 'inboxId', p_document, p_issued_at,
    p_nonce, p_key_id, p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document, ARRAY[
       'version','operation','inboxId','bodySha256','encryptionKeyId','nonceHex',
       'ciphertextSha256','authTagHex','bodyBytes','firstEventSequence',
       'lastEventSequence','eventCount','receivedAt','expiresAt','retainUntil'
     ])
     OR document ->> 'version' <> '1'
     OR document ->> 'operation' <> 'xero.accept'
     OR NOT control_plane.is_ulid(document ->> 'inboxId')
     OR document ->> 'bodySha256' !~ '^[0-9a-f]{64}$'
     OR document ->> 'encryptionKeyId' !~ '^[a-z][a-z0-9._-]{0,63}$'
     OR document ->> 'nonceHex' !~ '^[0-9a-f]{24}$'
     OR document ->> 'ciphertextSha256' !~ '^[0-9a-f]{64}$'
     OR document ->> 'authTagHex' !~ '^[0-9a-f]{32}$'
     OR encode(p_encryption_nonce, 'hex') IS DISTINCT FROM document ->> 'nonceHex'
     OR encode(extensions.digest(p_ciphertext, 'sha256'), 'hex')
          IS DISTINCT FROM document ->> 'ciphertextSha256'
     OR encode(p_auth_tag, 'hex') IS DISTINCT FROM document ->> 'authTagHex' THEN
    RAISE EXCEPTION 'xero webhook acceptance document is invalid' USING ERRCODE = '22023';
  END IF;
  body_bytes := control_plane.webhook_document_integer(document, 'bodyBytes', 1, 1048576)::integer;
  first_sequence := control_plane.webhook_document_integer(
    document, 'firstEventSequence', 0, 2147483647
  )::integer;
  last_sequence := control_plane.webhook_document_integer(
    document, 'lastEventSequence', 0, 2147483647
  )::integer;
  event_count := control_plane.webhook_document_integer(document, 'eventCount', 0, 1000)::integer;
  received_at := control_plane.webhook_document_timestamp(document, 'receivedAt');
  expires_at := control_plane.webhook_document_timestamp(document, 'expiresAt');
  retain_until := control_plane.webhook_document_timestamp(document, 'retainUntil');
  IF octet_length(p_encryption_nonce) <> 12
     OR octet_length(p_ciphertext) <> body_bytes
     OR octet_length(p_auth_tag) <> 16 THEN
    RAISE EXCEPTION 'xero webhook encrypted body binding is invalid' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT accepted.inbox_id, accepted.status, accepted.created, accepted.delivery_count
    FROM control_plane.accept_xero_webhook_inbox(
      document ->> 'inboxId', document ->> 'bodySha256',
      document ->> 'encryptionKeyId', p_encryption_nonce, p_ciphertext, p_auth_tag,
      body_bytes, first_sequence, last_sequence, event_count,
      received_at, expires_at, retain_until
    ) AS accepted;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.claim_attested_xero_webhook_inbox(
  p_document text,
  p_issued_at bigint,
  p_nonce text,
  p_key_id text,
  p_signature text
)
RETURNS TABLE (
  inbox_id text,
  body_sha256 text,
  encryption_key_id text,
  nonce bytea,
  ciphertext bytea,
  auth_tag bytea,
  body_bytes integer,
  first_event_sequence integer,
  last_event_sequence integer,
  event_count integer,
  first_received_at timestamptz,
  attempt_count integer,
  lease_token text,
  lease_version bigint
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  document jsonb;
  worker_id text;
  claim_limit integer;
  lease_seconds integer;
BEGIN
  BEGIN
    document := p_document::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'xero webhook claim document is invalid' USING ERRCODE = '22023';
  END;
  document := control_plane.consume_webhook_attestation(
    'xero.claim', document ->> 'workerId', p_document, p_issued_at,
    p_nonce, p_key_id, p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(
       document, ARRAY['version','operation','workerId','limit','leaseSeconds']
     )
     OR document ->> 'version' <> '1'
     OR document ->> 'operation' <> 'xero.claim'
     OR document ->> 'workerId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' THEN
    RAISE EXCEPTION 'xero webhook claim document is invalid' USING ERRCODE = '22023';
  END IF;
  worker_id := document ->> 'workerId';
  claim_limit := control_plane.webhook_document_integer(document, 'limit', 1, 10)::integer;
  lease_seconds := control_plane.webhook_document_integer(
    document, 'leaseSeconds', 30, 300
  )::integer;

  WITH expired_candidates AS (
    SELECT item.inbox_id
      FROM control_plane.xero_webhook_inbox AS item
     WHERE item.expires_at <= clock_timestamp()
       AND item.status IN ('pending', 'processing', 'retry_wait', 'failed')
     ORDER BY item.expires_at, item.inbox_id
     FOR UPDATE SKIP LOCKED
     LIMIT claim_limit
  )
  UPDATE control_plane.xero_webhook_inbox AS expired
     SET status = 'expired', lease_owner = NULL, lease_expires_at = NULL,
         lease_token = NULL, ciphertext = NULL, nonce = NULL, auth_tag = NULL,
         last_error_code = 'inbox_retention_expired'
    FROM expired_candidates
   WHERE expired.inbox_id = expired_candidates.inbox_id;

  RETURN QUERY
  WITH candidates AS (
    SELECT item.inbox_id
      FROM control_plane.xero_webhook_inbox AS item
     WHERE item.expires_at > clock_timestamp()
       AND (
         (item.status IN ('pending', 'retry_wait') AND item.next_attempt_at <= clock_timestamp())
         OR (item.status = 'processing' AND item.lease_expires_at <= clock_timestamp())
       )
     ORDER BY item.first_received_at, item.inbox_id
     FOR UPDATE SKIP LOCKED
     LIMIT claim_limit
  ), claimed AS (
    UPDATE control_plane.xero_webhook_inbox AS item
       SET status = 'processing',
           lease_owner = worker_id,
           lease_token = translate(
             rtrim(encode(extensions.gen_random_bytes(16), 'base64'), '='),
             '+/', '-_'
           ),
           lease_version = item.lease_version + 1,
           lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds),
           attempt_count = item.attempt_count + 1,
           last_error_code = NULL
      FROM candidates
     WHERE item.inbox_id = candidates.inbox_id
    RETURNING item.*
  )
  SELECT claimed.inbox_id, claimed.body_sha256, claimed.encryption_key_id,
         claimed.nonce, claimed.ciphertext, claimed.auth_tag, claimed.body_bytes,
         claimed.first_event_sequence, claimed.last_event_sequence,
         claimed.event_count, claimed.first_received_at, claimed.attempt_count,
         claimed.lease_token, claimed.lease_version
    FROM claimed
   ORDER BY claimed.first_received_at, claimed.inbox_id;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.renew_attested_xero_webhook_inbox_lease(
  p_document text,
  p_issued_at bigint,
  p_nonce text,
  p_key_id text,
  p_signature text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  document jsonb;
  lease_seconds integer;
  bound_lease_version bigint;
  renewed boolean;
BEGIN
  BEGIN document := p_document::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'xero webhook renewal document is invalid' USING ERRCODE = '22023';
  END;
  document := control_plane.consume_webhook_attestation(
    'xero.renew', document ->> 'inboxId', p_document, p_issued_at,
    p_nonce, p_key_id, p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document, ARRAY[
       'version','operation','inboxId','workerId','leaseToken','leaseVersion','leaseSeconds'
     ])
     OR document ->> 'version' <> '1'
     OR document ->> 'operation' <> 'xero.renew'
     OR NOT control_plane.is_ulid(document ->> 'inboxId')
     OR document ->> 'workerId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR document ->> 'leaseToken' !~ '^[A-Za-z0-9_-]{22}$' THEN
    RAISE EXCEPTION 'xero webhook renewal document is invalid' USING ERRCODE = '22023';
  END IF;
  bound_lease_version := control_plane.webhook_document_integer(
    document, 'leaseVersion', 1, 9223372036854775807
  );
  lease_seconds := control_plane.webhook_document_integer(
    document, 'leaseSeconds', 30, 300
  )::integer;
  UPDATE control_plane.xero_webhook_inbox AS item
     SET lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds)
   WHERE item.inbox_id = document ->> 'inboxId'
     AND item.status = 'processing'
     AND item.lease_owner = document ->> 'workerId'
     AND item.lease_token = document ->> 'leaseToken'
     AND item.lease_version = bound_lease_version
     AND item.lease_expires_at > clock_timestamp()
  RETURNING true INTO renewed;
  RETURN coalesce(renewed, false);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.record_attested_xero_webhook_sequence(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text
)
RETURNS TABLE (
  disposition text,gap_id text,gap_first_sequence integer,gap_last_sequence integer
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE document jsonb; bound_lease_version bigint;
BEGIN
  BEGIN document := p_document::jsonb; EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'xero sequence document is invalid' USING ERRCODE = '22023';
  END;
  document := control_plane.consume_webhook_attestation(
    'xero.sequence',document->>'inboxId',p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document,ARRAY[
       'version','operation','inboxId','workerId','leaseToken','leaseVersion'
     ]) OR document->>'version'<>'1' OR document->>'operation'<>'xero.sequence'
     OR NOT control_plane.is_ulid(document->>'inboxId')
     OR document->>'workerId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR document->>'leaseToken' !~ '^[A-Za-z0-9_-]{22}$' THEN
    RAISE EXCEPTION 'xero sequence document is invalid' USING ERRCODE = '22023';
  END IF;
  bound_lease_version := control_plane.webhook_document_integer(
    document,'leaseVersion',1,9223372036854775807
  );
  PERFORM control_plane.assert_xero_webhook_lease_fence(
    document->>'inboxId',document->>'workerId',document->>'leaseToken',bound_lease_version
  );
  RETURN QUERY SELECT observed.disposition,observed.gap_id,
                      observed.gap_first_sequence,observed.gap_last_sequence
    FROM control_plane.record_xero_webhook_sequence(
      document->>'inboxId',document->>'workerId'
    ) AS observed;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.record_attested_xero_webhook_connection_delivery(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text
)
RETURNS TABLE (created boolean, disposition text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE document jsonb; bound_lease_version bigint; streams text[];
BEGIN
  BEGIN document := p_document::jsonb; EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'xero connection delivery document is invalid' USING ERRCODE = '22023';
  END;
  document := control_plane.consume_webhook_attestation(
    'xero.connection',document->>'inboxId',p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document,ARRAY[
       'version','operation','tenantId','connectionId','inboxId','workerId',
       'leaseToken','leaseVersion','streams'
     ]) OR document->>'version'<>'1' OR document->>'operation'<>'xero.connection'
     OR NOT control_plane.is_ulid(document->>'tenantId')
     OR NOT control_plane.is_ulid(document->>'connectionId')
     OR NOT control_plane.is_ulid(document->>'inboxId')
     OR document->>'workerId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR document->>'leaseToken' !~ '^[A-Za-z0-9_-]{22}$'
     OR jsonb_typeof(document->'streams') <> 'array'
     OR jsonb_array_length(document->'streams') NOT BETWEEN 1 AND 3
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(document->'streams') AS stream(value)
        WHERE jsonb_typeof(stream.value) <> 'string'
     ) THEN
    RAISE EXCEPTION 'xero connection delivery document is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(stream.value ORDER BY stream.ordinality) INTO streams
    FROM jsonb_array_elements_text(document->'streams') WITH ORDINALITY AS stream(value,ordinality);
  IF streams IS DISTINCT FROM ARRAY(SELECT DISTINCT unnest(streams) ORDER BY 1)
     OR NOT streams <@ ARRAY['contacts','credit_notes','invoices']::text[] THEN
    RAISE EXCEPTION 'xero connection delivery streams are invalid' USING ERRCODE = '22023';
  END IF;
  bound_lease_version := control_plane.webhook_document_integer(
    document,'leaseVersion',1,9223372036854775807
  );
  PERFORM control_plane.assert_xero_webhook_lease_fence(
    document->>'inboxId',document->>'workerId',document->>'leaseToken',bound_lease_version
  );
  IF EXISTS (
    SELECT 1 FROM unnest(streams) AS expected(stream)
     WHERE NOT EXISTS (
       SELECT 1 FROM control_plane.webhook_receipts AS receipt
        WHERE receipt.tenant_id=document->>'tenantId'
          AND receipt.connection_id=document->>'connectionId'
          AND receipt.connector_key='xero'
          AND receipt.signature_verified
          AND receipt.dedupe_key='xero:'||(document->>'inboxId')||':'||expected.stream
          AND receipt.raw_object_key IS NOT NULL
          AND receipt.status='queued'
     )
  ) THEN
    RAISE EXCEPTION 'Xero connection delivery has an unrouted stream' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT delivered.created,delivered.disposition
    FROM control_plane.record_xero_webhook_connection_delivery(
      document->>'tenantId',document->>'connectionId',document->>'inboxId',streams
    ) AS delivered;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.enqueue_attested_xero_webhook_gap_sweeps(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE document jsonb; bound_lease_version bigint; observed_at timestamptz;
BEGIN
  BEGIN document := p_document::jsonb; EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'xero gap sweep document is invalid' USING ERRCODE = '22023';
  END;
  document := control_plane.consume_webhook_attestation(
    'xero.gap',document->>'gapId',p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document,ARRAY[
       'version','operation','gapId','inboxId','workerId','leaseToken','leaseVersion','observedAt'
     ]) OR document->>'version'<>'1' OR document->>'operation'<>'xero.gap'
     OR NOT control_plane.is_ulid(document->>'gapId')
     OR NOT control_plane.is_ulid(document->>'inboxId')
     OR document->>'workerId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR document->>'leaseToken' !~ '^[A-Za-z0-9_-]{22}$' THEN
    RAISE EXCEPTION 'xero gap sweep document is invalid' USING ERRCODE = '22023';
  END IF;
  bound_lease_version := control_plane.webhook_document_integer(
    document,'leaseVersion',1,9223372036854775807
  );
  observed_at := control_plane.webhook_document_timestamp(document,'observedAt');
  PERFORM control_plane.assert_xero_webhook_lease_fence(
    document->>'inboxId',document->>'workerId',document->>'leaseToken',bound_lease_version
  );
  PERFORM 1
    FROM control_plane.xero_webhook_gaps AS gap
    JOIN control_plane.xero_webhook_inbox AS inbox
      ON inbox.inbox_id = gap.source_inbox_id
   WHERE gap.gap_id = document->>'gapId'
     AND gap.source_inbox_id = document->>'inboxId'
     AND inbox.first_received_at = observed_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'xero gap sweep binding was not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.enqueue_xero_webhook_gap_sweeps(document->>'gapId',observed_at);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.enqueue_attested_xero_webhook_incremental(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE document jsonb; bound_lease_version bigint; bound_received_at timestamptz;
BEGIN
  BEGIN document := p_document::jsonb; EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'xero incremental document is invalid' USING ERRCODE = '22023';
  END;
  document := control_plane.consume_webhook_attestation(
    'xero.enqueue',document->>'receiptId',p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document,ARRAY[
       'version','operation','tenantId','connectionId','inboxId','workerId',
       'leaseToken','leaseVersion','receiptId','stream','receivedAt'
     ]) OR document->>'version'<>'1' OR document->>'operation'<>'xero.enqueue'
     OR NOT control_plane.is_ulid(document->>'tenantId')
     OR NOT control_plane.is_ulid(document->>'connectionId')
     OR NOT control_plane.is_ulid(document->>'inboxId')
     OR NOT control_plane.is_ulid(document->>'receiptId')
     OR document->>'workerId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR document->>'leaseToken' !~ '^[A-Za-z0-9_-]{22}$'
     OR document->>'stream' NOT IN ('contacts','invoices','credit_notes') THEN
    RAISE EXCEPTION 'xero incremental document is invalid' USING ERRCODE = '22023';
  END IF;
  bound_lease_version := control_plane.webhook_document_integer(
    document,'leaseVersion',1,9223372036854775807
  );
  bound_received_at := control_plane.webhook_document_timestamp(document,'receivedAt');
  PERFORM control_plane.assert_xero_webhook_lease_fence(
    document->>'inboxId',document->>'workerId',document->>'leaseToken',bound_lease_version
  );
  PERFORM 1 FROM control_plane.webhook_receipts AS receipt
   WHERE receipt.tenant_id=document->>'tenantId'
     AND receipt.connection_id=document->>'connectionId'
     AND receipt.webhook_receipt_id=document->>'receiptId'
     AND receipt.connector_key='xero'
     AND receipt.signature_verified
     AND receipt.received_at=bound_received_at
     AND receipt.dedupe_key='xero:'||(document->>'inboxId')||':'||(document->>'stream')
     AND receipt.raw_object_key IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attested Xero receipt is incomplete' USING ERRCODE = '55000';
  END IF;
  RETURN control_plane.enqueue_xero_webhook_incremental(
    document->>'tenantId',document->>'connectionId',document->>'inboxId',
    document->>'receiptId',document->>'stream',bound_received_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_attested_xero_webhook_inbox(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE document jsonb; bound_lease_version bigint; summary jsonb;
BEGIN
  BEGIN document := p_document::jsonb; EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'xero completion document is invalid' USING ERRCODE = '22023';
  END;
  document := control_plane.consume_webhook_attestation(
    'xero.complete',document->>'inboxId',p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document,ARRAY[
       'version','operation','inboxId','workerId','leaseToken','leaseVersion','summary'
     ]) OR document->>'version'<>'1' OR document->>'operation'<>'xero.complete'
     OR NOT control_plane.is_ulid(document->>'inboxId')
     OR document->>'workerId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR document->>'leaseToken' !~ '^[A-Za-z0-9_-]{22}$' THEN
    RAISE EXCEPTION 'xero completion document is invalid' USING ERRCODE = '22023';
  END IF;
  summary := document->'summary';
  IF jsonb_typeof(summary)<>'object' OR octet_length(summary::text)>4096
     OR NOT summary ?& ARRAY[
       'partitionCount','matchedConnectionCount','routedStreamCount',
       'unmatchedPartitionCount','ignoredEventCount','sequenceDisposition','gapRecoveryCount'
     ]
     OR (SELECT count(*) FROM jsonb_object_keys(summary))<>7
     OR summary->>'sequenceDisposition' NOT IN (
       'intent','initial','contiguous','gap','overlap','out_of_order'
     ) OR EXISTS (
       SELECT 1 FROM jsonb_each(summary) AS field(name,value)
        WHERE field.name<>'sequenceDisposition'
          AND (jsonb_typeof(field.value)<>'number' OR field.value::text !~ '^(0|[1-9][0-9]{0,8})$')
     ) THEN
    RAISE EXCEPTION 'xero completion summary is invalid' USING ERRCODE = '22023';
  END IF;
  bound_lease_version := control_plane.webhook_document_integer(
    document,'leaseVersion',1,9223372036854775807
  );
  PERFORM control_plane.assert_xero_webhook_lease_fence(
    document->>'inboxId',document->>'workerId',document->>'leaseToken',bound_lease_version
  );
  PERFORM 1 FROM control_plane.xero_webhook_sequence_observations AS observation
   WHERE observation.inbox_id=document->>'inboxId'
     AND observation.disposition=summary->>'sequenceDisposition';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'xero completion is not bound to its sequence observation' USING ERRCODE='55000';
  END IF;
  UPDATE control_plane.xero_webhook_inbox AS item
     SET status='processed',processed_at=clock_timestamp(),route_summary=summary,
         ciphertext=NULL,nonce=NULL,auth_tag=NULL,lease_owner=NULL,
         lease_expires_at=NULL,lease_token=NULL,last_error_code=NULL
   WHERE item.inbox_id=document->>'inboxId'
     AND item.status='processing'
     AND item.lease_owner=document->>'workerId'
     AND item.lease_token=document->>'leaseToken'
     AND item.lease_version=bound_lease_version
     AND item.lease_expires_at>clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'xero webhook lease fence is not owned' USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.fail_attested_xero_webhook_inbox(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  document jsonb; bound_lease_version bigint; item record; next_status text;
  retry_seconds integer; max_attempts integer; permanent boolean;
BEGIN
  BEGIN document := p_document::jsonb; EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'xero failure document is invalid' USING ERRCODE = '22023';
  END;
  document := control_plane.consume_webhook_attestation(
    'xero.fail',document->>'inboxId',p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document,ARRAY[
       'version','operation','inboxId','workerId','leaseToken','leaseVersion',
       'errorCode','retryDelaySeconds','maxAttempts','permanent'
     ]) OR document->>'version'<>'1' OR document->>'operation'<>'xero.fail'
     OR NOT control_plane.is_ulid(document->>'inboxId')
     OR document->>'workerId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR document->>'leaseToken' !~ '^[A-Za-z0-9_-]{22}$'
     OR document->>'errorCode' !~ '^[a-z][a-z0-9_.-]{0,79}$'
     OR jsonb_typeof(document->'permanent')<>'boolean' THEN
    RAISE EXCEPTION 'xero failure document is invalid' USING ERRCODE = '22023';
  END IF;
  bound_lease_version := control_plane.webhook_document_integer(
    document,'leaseVersion',1,9223372036854775807
  );
  retry_seconds := control_plane.webhook_document_integer(
    document,'retryDelaySeconds',1,86400
  )::integer;
  max_attempts := control_plane.webhook_document_integer(document,'maxAttempts',1,100)::integer;
  permanent := (document->>'permanent')::boolean;
  PERFORM control_plane.assert_xero_webhook_lease_fence(
    document->>'inboxId',document->>'workerId',document->>'leaseToken',bound_lease_version
  );
  SELECT inbox.attempt_count,inbox.expires_at INTO item
    FROM control_plane.xero_webhook_inbox AS inbox
   WHERE inbox.inbox_id=document->>'inboxId'
   FOR UPDATE;
  next_status := CASE
    WHEN item.expires_at<=clock_timestamp() THEN 'expired'
    WHEN permanent OR item.attempt_count>=max_attempts THEN 'failed'
    ELSE 'retry_wait'
  END;
  UPDATE control_plane.xero_webhook_inbox
     SET status=next_status,lease_owner=NULL,lease_expires_at=NULL,lease_token=NULL,
         next_attempt_at=clock_timestamp()+make_interval(secs=>retry_seconds),
         last_error_code=document->>'errorCode',
         ciphertext=CASE WHEN next_status IN ('expired','failed') THEN NULL ELSE ciphertext END,
         nonce=CASE WHEN next_status IN ('expired','failed') THEN NULL ELSE nonce END,
         auth_tag=CASE WHEN next_status IN ('expired','failed') THEN NULL ELSE auth_tag END
   WHERE inbox_id=document->>'inboxId';
  RETURN next_status;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.attested_xero_webhook_inbox_health(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text
)
RETURNS TABLE (
  pending_count bigint,processing_count bigint,retry_count bigint,
  failed_count bigint,expired_count bigint,oldest_unprocessed_at timestamptz,
  active_key_ids text[]
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE document jsonb;
BEGIN
  document := control_plane.consume_webhook_attestation(
    'xero.health','xero-inbox',p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document,ARRAY['version','operation'])
     OR document->>'version'<>'1' OR document->>'operation'<>'xero.health' THEN
    RAISE EXCEPTION 'xero health document is invalid' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT health.pending_count,health.processing_count,health.retry_count,
                      health.failed_count,health.expired_count,
                      health.oldest_unprocessed_at,health.active_key_ids
    FROM control_plane.xero_webhook_inbox_health() AS health;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.resolve_attested_xero_webhook_connections(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text
)
RETURNS TABLE (
  tenant_id text,connection_id text,connector_key text,external_account_reference text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE document jsonb; external_references text[];
BEGIN
  document := control_plane.consume_webhook_attestation(
    'xero.resolve','xero-connections',p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(
       document,ARRAY['version','operation','externalAccountReferences']
     ) OR document->>'version'<>'1' OR document->>'operation'<>'xero.resolve'
     OR jsonb_typeof(document->'externalAccountReferences')<>'array'
     OR jsonb_array_length(document->'externalAccountReferences') NOT BETWEEN 1 AND 1000
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(document->'externalAccountReferences') AS ref(value)
        WHERE jsonb_typeof(ref.value)<>'string'
     ) THEN
    RAISE EXCEPTION 'xero connection resolution document is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(ref.value ORDER BY ref.ordinality) INTO external_references
    FROM jsonb_array_elements_text(document->'externalAccountReferences')
         WITH ORDINALITY AS ref(value,ordinality);
  IF external_references IS DISTINCT FROM ARRAY(
       SELECT DISTINCT unnest(external_references) ORDER BY 1
     ) THEN
    RAISE EXCEPTION 'xero connection references are not canonical' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT resolved.tenant_id,resolved.connection_id,resolved.connector_key,
                      resolved.external_account_reference
    FROM control_plane.resolve_xero_webhook_connections(external_references) AS resolved;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.resolve_attested_deputy_webhook_material(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text
)
RETURNS TABLE (
  tenant_id text,connection_id text,connector_key text,external_account_reference text,
  material_id text,material_version integer,verification_mode text,
  envelope_version integer,algorithm text,key_id text,iv text,ciphertext text,callback_url text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE document jsonb;
BEGIN
  BEGIN document:=p_document::jsonb; EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Deputy material resolution document is invalid' USING ERRCODE='22023';
  END;
  document:=control_plane.consume_webhook_attestation(
    'deputy.resolve',document->>'connectionId',p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(
       document,ARRAY['version','operation','connectionId','materialId']
     ) OR document->>'version'<>'1' OR document->>'operation'<>'deputy.resolve'
     OR NOT control_plane.is_ulid(document->>'connectionId')
     OR NOT control_plane.is_ulid(document->>'materialId') THEN
    RAISE EXCEPTION 'Deputy material resolution document is invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT resolved.tenant_id,resolved.connection_id,resolved.connector_key,
                      resolved.external_account_reference,resolved.material_id,
                      resolved.material_version,resolved.verification_mode,
                      resolved.envelope_version,resolved.algorithm,resolved.key_id,
                      resolved.iv,resolved.ciphertext,resolved.callback_url
    FROM control_plane.resolve_deputy_webhook_material(
      document->>'connectionId',document->>'materialId'
    ) AS resolved;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.reserve_attested_webhook_receipt(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text,p_receipt_id text
)
RETURNS TABLE (
  webhook_receipt_id text,status text,raw_object_key text,duplicate boolean,received_at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  document jsonb; inserted_id text; existing record; bound_received_at timestamptz;
  bound_lease_version bigint;
BEGIN
  document:=control_plane.consume_webhook_attestation(
    'receipt.reserve',p_receipt_id,p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document,ARRAY[
       'version','operation','tenantId','connectionId','connectorKey','verificationReference',
       'leaseOwner','leaseToken','leaseVersion','receiptId','dedupeKey','vendorEventId',
       'bodySha256','safeHeaders','receivedAt'
     ]) OR document->>'version'<>'1' OR document->>'operation'<>'receipt.reserve'
     OR document->>'receiptId' IS DISTINCT FROM p_receipt_id
     OR NOT control_plane.is_ulid(document->>'tenantId')
     OR NOT control_plane.is_ulid(document->>'connectionId')
     OR NOT control_plane.is_ulid(document->>'receiptId')
     OR NOT control_plane.is_ulid(document->>'verificationReference')
     OR document->>'connectorKey' NOT IN ('deputy','xero')
     OR length(btrim(coalesce(document->>'dedupeKey',''))) NOT BETWEEN 1 AND 1000
     OR coalesce(document->>'dedupeKey','') ~ '[[:cntrl:]]'
     OR document->>'bodySha256' !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(document->'safeHeaders')<>'object'
     OR octet_length((document->'safeHeaders')::text)>4096
     OR jsonb_typeof(document->'vendorEventId') NOT IN ('string','null')
     OR length(coalesce(document->>'vendorEventId',''))>300 THEN
    RAISE EXCEPTION 'webhook receipt attestation document is invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(document->'safeHeaders') AS header(name,value)
     WHERE header.name NOT IN (
       'content-type','user-agent','x-request-id','x-deputy-generation-time',
       'source_body_sha256','inbox_key_id'
     ) OR jsonb_typeof(header.value)<>'string'
       OR length(header.value#>>'{}')>300 OR (header.value#>>'{}')~'[[:cntrl:]]'
  ) THEN
    RAISE EXCEPTION 'webhook receipt safe headers are invalid' USING ERRCODE='22023';
  END IF;
  bound_received_at:=control_plane.webhook_document_timestamp(document,'receivedAt');
  IF bound_received_at<clock_timestamp()-interval '7 days'
     OR bound_received_at>clock_timestamp()+interval '5 minutes' THEN
    RAISE EXCEPTION 'webhook receipt time is invalid' USING ERRCODE='22023';
  END IF;
  IF document->>'connectorKey'='deputy' THEN
    IF jsonb_typeof(document->'leaseOwner')<>'null'
       OR jsonb_typeof(document->'leaseToken')<>'null'
       OR jsonb_typeof(document->'leaseVersion')<>'null' THEN
      RAISE EXCEPTION 'Deputy receipt lease fields are invalid' USING ERRCODE='22023';
    END IF;
    PERFORM 1 FROM control_plane.connections AS connection
      JOIN control_plane.deputy_webhook_material AS material
        ON material.tenant_id=connection.tenant_id
       AND material.connection_id=connection.connection_id
     WHERE connection.tenant_id=document->>'tenantId'
       AND connection.connection_id=document->>'connectionId'
       AND connection.connector_key='deputy'
       AND connection.status IN ('connected','degraded')
       AND material.material_id=document->>'verificationReference'
       AND material.retired_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active Deputy verifier was not found' USING ERRCODE='P0002';
    END IF;
  ELSE
    IF document->>'leaseOwner' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
       OR document->>'leaseToken' !~ '^[A-Za-z0-9_-]{22}$' THEN
      RAISE EXCEPTION 'Xero receipt lease fields are invalid' USING ERRCODE='22023';
    END IF;
    bound_lease_version:=control_plane.webhook_document_integer(
      document,'leaseVersion',1,9223372036854775807
    );
    PERFORM control_plane.assert_xero_webhook_lease_fence(
      document->>'verificationReference',document->>'leaseOwner',
      document->>'leaseToken',bound_lease_version
    );
    PERFORM 1 FROM control_plane.connections AS connection
      JOIN control_plane.xero_webhook_inbox AS inbox
        ON inbox.inbox_id=document->>'verificationReference'
     WHERE connection.tenant_id=document->>'tenantId'
       AND connection.connection_id=document->>'connectionId'
       AND connection.connector_key='xero'
       AND connection.status IN ('connected','degraded')
       AND document->>'dedupeKey' = ANY(ARRAY[
         'xero:'||(document->>'verificationReference')||':contacts',
         'xero:'||(document->>'verificationReference')||':invoices',
         'xero:'||(document->>'verificationReference')||':credit_notes'
       ])
       AND document->>'vendorEventId'=document->>'verificationReference'
       AND document->'safeHeaders'->>'source_body_sha256'=inbox.body_sha256
       AND document->'safeHeaders'->>'inbox_key_id'=inbox.encryption_key_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active Xero receipt binding was not found' USING ERRCODE='P0002';
    END IF;
  END IF;
  INSERT INTO control_plane.webhook_receipts(
    tenant_id,webhook_receipt_id,connection_id,connector_key,vendor_event_id,
    dedupe_key,body_sha256,signature_verified,safe_headers,status,received_at
  ) VALUES (
    document->>'tenantId',p_receipt_id,document->>'connectionId',document->>'connectorKey',
    nullif(document->>'vendorEventId',''),document->>'dedupeKey',document->>'bodySha256',
    true,document->'safeHeaders','received',bound_received_at
  ) ON CONFLICT (tenant_id,connection_id,dedupe_key) DO NOTHING
  RETURNING control_plane.webhook_receipts.webhook_receipt_id INTO inserted_id;
  SELECT receipt.webhook_receipt_id,receipt.body_sha256,receipt.status,
         receipt.raw_object_key,receipt.connector_key,receipt.received_at
    INTO existing FROM control_plane.webhook_receipts AS receipt
   WHERE receipt.tenant_id=document->>'tenantId'
     AND receipt.connection_id=document->>'connectionId'
     AND receipt.dedupe_key=document->>'dedupeKey'
   FOR UPDATE;
  IF NOT FOUND OR existing.body_sha256<>document->>'bodySha256'
     OR existing.connector_key<>document->>'connectorKey' THEN
    RAISE EXCEPTION 'webhook receipt dedupe collision' USING ERRCODE='22000';
  END IF;
  RETURN QUERY SELECT existing.webhook_receipt_id,existing.status,
                      existing.raw_object_key,inserted_id IS NULL,existing.received_at;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.attach_attested_webhook_raw(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  document jsonb; receipt record; expected_key text; bound_lease_version bigint;
BEGIN
  BEGIN document:=p_document::jsonb; EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'webhook raw attachment document is invalid' USING ERRCODE='22023';
  END;
  document:=control_plane.consume_webhook_attestation(
    'receipt.attach',document->>'receiptId',p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document,ARRAY[
       'version','operation','tenantId','connectionId','connectorKey','verificationReference',
       'leaseOwner','leaseToken','leaseVersion','receiptId','objectKey'
     ]) OR document->>'version'<>'1' OR document->>'operation'<>'receipt.attach'
     OR NOT control_plane.is_ulid(document->>'tenantId')
     OR NOT control_plane.is_ulid(document->>'connectionId')
     OR NOT control_plane.is_ulid(document->>'verificationReference')
     OR NOT control_plane.is_ulid(document->>'receiptId')
     OR document->>'connectorKey' NOT IN ('deputy','xero')
     OR jsonb_typeof(document->'objectKey')<>'string' THEN
    RAISE EXCEPTION 'webhook raw attachment document is invalid' USING ERRCODE='22023';
  END IF;
  IF document->>'connectorKey'='deputy' THEN
    IF jsonb_typeof(document->'leaseOwner')<>'null'
       OR jsonb_typeof(document->'leaseToken')<>'null'
       OR jsonb_typeof(document->'leaseVersion')<>'null' THEN
      RAISE EXCEPTION 'Deputy receipt lease fields are invalid' USING ERRCODE='22023';
    END IF;
    PERFORM 1 FROM control_plane.deputy_webhook_material AS material
     WHERE material.tenant_id=document->>'tenantId'
       AND material.connection_id=document->>'connectionId'
       AND material.material_id=document->>'verificationReference'
       AND material.retired_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'active Deputy verifier was not found' USING ERRCODE='P0002'; END IF;
  ELSE
    bound_lease_version:=control_plane.webhook_document_integer(
      document,'leaseVersion',1,9223372036854775807
    );
    PERFORM control_plane.assert_xero_webhook_lease_fence(
      document->>'verificationReference',document->>'leaseOwner',
      document->>'leaseToken',bound_lease_version
    );
  END IF;
  SELECT item.connector_key,item.received_at,item.raw_object_key,
         item.dedupe_key,item.safe_headers INTO receipt
    FROM control_plane.webhook_receipts AS item
   WHERE item.tenant_id=document->>'tenantId'
     AND item.connection_id=document->>'connectionId'
     AND item.webhook_receipt_id=document->>'receiptId'
     AND item.connector_key=document->>'connectorKey'
     AND item.signature_verified AND item.status IN ('received','failed')
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'attested webhook receipt was not found' USING ERRCODE='P0002'; END IF;
  IF document->>'connectorKey'='xero' AND NOT EXISTS (
    SELECT 1 FROM control_plane.xero_webhook_inbox AS inbox
     WHERE inbox.inbox_id=document->>'verificationReference'
       AND receipt.dedupe_key = ANY(ARRAY[
         'xero:'||(document->>'verificationReference')||':contacts',
         'xero:'||(document->>'verificationReference')||':invoices',
         'xero:'||(document->>'verificationReference')||':credit_notes'
       ])
       AND receipt.safe_headers->>'source_body_sha256'=inbox.body_sha256
       AND receipt.safe_headers->>'inbox_key_id'=inbox.encryption_key_id
  ) THEN
    RAISE EXCEPTION 'Xero raw receipt is not bound to the leased inbox' USING ERRCODE='22023';
  END IF;
  expected_key:=concat_ws('/','tenant',document->>'tenantId','connection',
    document->>'connectionId','stream','webhook_'||receipt.connector_key,'date',
    to_char(receipt.received_at AT TIME ZONE 'UTC','YYYY-MM-DD'),
    'batch-'||(document->>'receiptId')||'.json.gz');
  IF document->>'objectKey' IS DISTINCT FROM expected_key
     OR (receipt.raw_object_key IS NOT NULL AND receipt.raw_object_key<>document->>'objectKey') THEN
    RAISE EXCEPTION 'webhook raw object binding is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.webhook_receipts
     SET raw_object_key=coalesce(raw_object_key,document->>'objectKey')
   WHERE tenant_id=document->>'tenantId' AND connection_id=document->>'connectionId'
     AND webhook_receipt_id=document->>'receiptId';
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.fail_attested_webhook_receipt(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE document jsonb; bound_lease_version bigint; receipt record;
BEGIN
  BEGIN document:=p_document::jsonb; EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'webhook receipt failure document is invalid' USING ERRCODE='22023';
  END;
  document:=control_plane.consume_webhook_attestation(
    'receipt.fail',document->>'receiptId',p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(document,ARRAY[
       'version','operation','tenantId','connectionId','connectorKey','verificationReference',
       'leaseOwner','leaseToken','leaseVersion','receiptId'
     ]) OR document->>'version'<>'1' OR document->>'operation'<>'receipt.fail'
     OR NOT control_plane.is_ulid(document->>'tenantId')
     OR NOT control_plane.is_ulid(document->>'connectionId')
     OR NOT control_plane.is_ulid(document->>'verificationReference')
     OR NOT control_plane.is_ulid(document->>'receiptId')
     OR document->>'connectorKey' NOT IN ('deputy','xero') THEN
    RAISE EXCEPTION 'webhook receipt failure document is invalid' USING ERRCODE='22023';
  END IF;
  IF document->>'connectorKey'='deputy' THEN
    IF jsonb_typeof(document->'leaseOwner')<>'null'
       OR jsonb_typeof(document->'leaseToken')<>'null'
       OR jsonb_typeof(document->'leaseVersion')<>'null' THEN
      RAISE EXCEPTION 'Deputy receipt lease fields are invalid' USING ERRCODE='22023';
    END IF;
    PERFORM 1 FROM control_plane.deputy_webhook_material AS material
     WHERE material.tenant_id=document->>'tenantId'
       AND material.connection_id=document->>'connectionId'
       AND material.material_id=document->>'verificationReference'
       AND material.retired_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'active Deputy verifier was not found' USING ERRCODE='P0002'; END IF;
  ELSE
    bound_lease_version:=control_plane.webhook_document_integer(
      document,'leaseVersion',1,9223372036854775807
    );
    PERFORM control_plane.assert_xero_webhook_lease_fence(
      document->>'verificationReference',document->>'leaseOwner',
      document->>'leaseToken',bound_lease_version
    );
  END IF;
  SELECT item.status,item.dedupe_key,item.safe_headers INTO receipt
    FROM control_plane.webhook_receipts AS item
   WHERE item.tenant_id=document->>'tenantId'
     AND item.connection_id=document->>'connectionId'
     AND item.webhook_receipt_id=document->>'receiptId'
     AND item.connector_key=document->>'connectorKey'
     AND item.signature_verified
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attested webhook receipt was not found' USING ERRCODE='P0002';
  END IF;
  IF document->>'connectorKey'='xero' AND NOT EXISTS (
    SELECT 1 FROM control_plane.xero_webhook_inbox AS inbox
     WHERE inbox.inbox_id=document->>'verificationReference'
       AND receipt.dedupe_key = ANY(ARRAY[
         'xero:'||(document->>'verificationReference')||':contacts',
         'xero:'||(document->>'verificationReference')||':invoices',
         'xero:'||(document->>'verificationReference')||':credit_notes'
       ])
       AND receipt.safe_headers->>'source_body_sha256'=inbox.body_sha256
       AND receipt.safe_headers->>'inbox_key_id'=inbox.encryption_key_id
  ) THEN
    RAISE EXCEPTION 'Xero failed receipt is not bound to the leased inbox' USING ERRCODE='22023';
  END IF;
  IF receipt.status IN ('queued','ignored') THEN RETURN; END IF;
  UPDATE control_plane.webhook_receipts
     SET status='failed'
   WHERE tenant_id=document->>'tenantId' AND connection_id=document->>'connectionId'
     AND webhook_receipt_id=document->>'receiptId'
     AND connector_key=document->>'connectorKey'
     AND signature_verified AND status NOT IN ('queued','ignored');
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_attested_webhook_gateway_ready(
  p_document text,p_issued_at bigint,p_nonce text,p_key_id text,p_signature text
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE document jsonb; deputy_key_ids text[];
BEGIN
  BEGIN document:=p_document::jsonb; EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'webhook readiness challenge is invalid' USING ERRCODE='22023';
  END;
  document:=control_plane.consume_webhook_attestation(
    'system.ready',document->>'attestationKeyId',p_document,p_issued_at,p_nonce,p_key_id,p_signature
  );
  IF NOT control_plane.webhook_document_has_exact_keys(
       document,ARRAY['version','operation','attestationKeyId','deputyKeyIds']
     ) OR document->>'version'<>'1' OR document->>'operation'<>'system.ready'
     OR document->>'attestationKeyId' IS DISTINCT FROM p_key_id
     OR jsonb_typeof(document->'deputyKeyIds')<>'array'
     OR jsonb_array_length(document->'deputyKeyIds') NOT BETWEEN 1 AND 5
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(document->'deputyKeyIds') AS key(value)
        WHERE jsonb_typeof(key.value)<>'string'
          OR (key.value#>>'{}') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     ) THEN
    RAISE EXCEPTION 'webhook readiness challenge is invalid' USING ERRCODE='22023';
  END IF;
  SELECT array_agg(key.value ORDER BY key.ordinality) INTO deputy_key_ids
    FROM jsonb_array_elements_text(document->'deputyKeyIds')
         WITH ORDINALITY AS key(value,ordinality);
  IF deputy_key_ids IS DISTINCT FROM ARRAY(SELECT DISTINCT unnest(deputy_key_ids) ORDER BY 1) THEN
    RAISE EXCEPTION 'webhook readiness key ids are not canonical' USING ERRCODE='22023';
  END IF;
  -- Consuming the random one-use nonce above is the fresh signed challenge: a
  -- matching key ID with the wrong environment secret cannot pass this call.
  PERFORM control_plane.assert_deputy_webhook_gateway_ready(deputy_key_ids);
  PERFORM control_plane.assert_webhook_gateway_ready();
END;
$$;

-- The independent retention path must also clear a live fence whenever it
-- expires a processing row, otherwise the lifecycle check would reject the
-- cryptographic erasure transaction.
CREATE OR REPLACE FUNCTION control_plane.purge_xero_webhook_inbox(p_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'xero webhook purge limit is invalid' USING ERRCODE='22023';
  END IF;
  WITH expired_candidates AS (
    SELECT item.inbox_id FROM control_plane.xero_webhook_inbox AS item
     WHERE item.expires_at<=clock_timestamp()
       AND item.status IN ('pending','processing','retry_wait','failed')
     ORDER BY item.expires_at,item.inbox_id FOR UPDATE SKIP LOCKED LIMIT p_limit
  )
  UPDATE control_plane.xero_webhook_inbox AS item
     SET status='expired',lease_owner=NULL,lease_expires_at=NULL,lease_token=NULL,
         ciphertext=NULL,nonce=NULL,auth_tag=NULL,last_error_code='inbox_retention_expired'
    FROM expired_candidates WHERE item.inbox_id=expired_candidates.inbox_id;
  WITH candidates AS (
    SELECT item.inbox_id FROM control_plane.xero_webhook_inbox AS item
     WHERE item.status IN ('processed','failed','expired')
       AND item.retain_until<=clock_timestamp()
     ORDER BY item.retain_until,item.inbox_id FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), deleted AS (
    DELETE FROM control_plane.xero_webhook_inbox AS item USING candidates
     WHERE item.inbox_id=candidates.inbox_id RETURNING 1
  ) SELECT count(*)::integer INTO removed FROM deleted;
  RETURN removed;
END;
$$;

-- Private proof and parsing primitives are callable only by their owner.
REVOKE ALL ON FUNCTION control_plane.webhook_document_has_exact_keys(jsonb,text[]),
  control_plane.webhook_document_integer(jsonb,text,bigint,bigint),
  control_plane.webhook_document_timestamp(jsonb,text),
  control_plane.assert_xero_webhook_lease_fence(text,text,text,bigint)
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;

-- Revoke every historical edge entry point. SECURITY DEFINER wrappers above
-- can still compose the fixed owner-owned primitives, but the runtime login
-- cannot bypass proof verification or choose arbitrary payloads directly.
REVOKE EXECUTE ON FUNCTION
  control_plane.accept_xero_webhook_inbox(
    text,text,text,bytea,bytea,bytea,integer,integer,integer,integer,
    timestamptz,timestamptz,timestamptz
  ),
  control_plane.claim_xero_webhook_inbox(text,integer,integer),
  control_plane.renew_xero_webhook_inbox_lease(text,text,integer),
  control_plane.record_xero_webhook_sequence(text,text),
  control_plane.record_xero_webhook_connection_delivery(text,text,text,text[]),
  control_plane.enqueue_xero_webhook_incremental(text,text,text,text,text,timestamptz),
  control_plane.enqueue_xero_webhook_gap_sweeps(text,timestamptz),
  control_plane.complete_xero_webhook_inbox(text,text,jsonb),
  control_plane.fail_xero_webhook_inbox(text,text,text,integer,integer,boolean),
  control_plane.purge_xero_webhook_inbox(integer),
  control_plane.xero_webhook_inbox_health(),
  control_plane.assert_webhook_gateway_ready(),
  control_plane.assert_webhook_attestation_ready(text),
  control_plane.resolve_xero_webhook_connections(text[]),
  control_plane.resolve_deputy_webhook_material(text,text),
  control_plane.assert_deputy_webhook_gateway_ready(text[]),
  control_plane.enqueue_deputy_webhook_sync(text,text,text,text,timestamptz),
  control_plane.attach_attested_webhook_raw(text,text,text,text),
  control_plane.fail_attested_webhook_receipt(text,text,text)
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;

REVOKE ALL ON FUNCTION control_plane.install_webhook_attestation_key(text,bytea),
  control_plane.retire_webhook_attestation_key(text)
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;
GRANT EXECUTE ON FUNCTION control_plane.install_webhook_attestation_key(text,bytea),
  control_plane.retire_webhook_attestation_key(text)
TO albert_control_migration_owner;

REVOKE ALL ON FUNCTION
  control_plane.accept_attested_xero_webhook_inbox(text,bigint,text,text,text,bytea,bytea,bytea),
  control_plane.claim_attested_xero_webhook_inbox(text,bigint,text,text,text),
  control_plane.renew_attested_xero_webhook_inbox_lease(text,bigint,text,text,text),
  control_plane.record_attested_xero_webhook_sequence(text,bigint,text,text,text),
  control_plane.record_attested_xero_webhook_connection_delivery(text,bigint,text,text,text),
  control_plane.enqueue_attested_xero_webhook_gap_sweeps(text,bigint,text,text,text),
  control_plane.enqueue_attested_xero_webhook_incremental(text,bigint,text,text,text),
  control_plane.complete_attested_xero_webhook_inbox(text,bigint,text,text,text),
  control_plane.fail_attested_xero_webhook_inbox(text,bigint,text,text,text),
  control_plane.attested_xero_webhook_inbox_health(text,bigint,text,text,text),
  control_plane.resolve_attested_xero_webhook_connections(text,bigint,text,text,text),
  control_plane.resolve_attested_deputy_webhook_material(text,bigint,text,text,text),
  control_plane.reserve_attested_webhook_receipt(text,bigint,text,text,text,text),
  control_plane.attach_attested_webhook_raw(text,bigint,text,text,text),
  control_plane.finalize_attested_deputy_webhook(text,bigint,text,text,text,text),
  control_plane.fail_attested_webhook_receipt(text,bigint,text,text,text),
  control_plane.assert_attested_webhook_gateway_ready(text,bigint,text,text,text)
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;

GRANT EXECUTE ON FUNCTION
  control_plane.accept_attested_xero_webhook_inbox(text,bigint,text,text,text,bytea,bytea,bytea),
  control_plane.claim_attested_xero_webhook_inbox(text,bigint,text,text,text),
  control_plane.renew_attested_xero_webhook_inbox_lease(text,bigint,text,text,text),
  control_plane.record_attested_xero_webhook_sequence(text,bigint,text,text,text),
  control_plane.record_attested_xero_webhook_connection_delivery(text,bigint,text,text,text),
  control_plane.enqueue_attested_xero_webhook_gap_sweeps(text,bigint,text,text,text),
  control_plane.enqueue_attested_xero_webhook_incremental(text,bigint,text,text,text),
  control_plane.complete_attested_xero_webhook_inbox(text,bigint,text,text,text),
  control_plane.fail_attested_xero_webhook_inbox(text,bigint,text,text,text),
  control_plane.attested_xero_webhook_inbox_health(text,bigint,text,text,text),
  control_plane.resolve_attested_xero_webhook_connections(text,bigint,text,text,text),
  control_plane.resolve_attested_deputy_webhook_material(text,bigint,text,text,text),
  control_plane.reserve_attested_webhook_receipt(text,bigint,text,text,text,text),
  control_plane.attach_attested_webhook_raw(text,bigint,text,text,text),
  control_plane.finalize_attested_deputy_webhook(text,bigint,text,text,text,text),
  control_plane.fail_attested_webhook_receipt(text,bigint,text,text,text),
  control_plane.assert_attested_webhook_gateway_ready(text,bigint,text,text,text)
TO albert_webhook_control;

COMMIT;
