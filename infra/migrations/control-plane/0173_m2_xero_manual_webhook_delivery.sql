-- Xero is manual-sync-only from migration 0142. Its webhook receipt is still
-- verified, retained and bound to the connection delivery, but the terminal
-- receipt state is intentionally `ignored` rather than `queued`. Keep the
-- proof-gated delivery ledger compatible with both the historical queued path
-- and the current manual-sync path.

BEGIN;

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
          AND receipt.status IN ('queued','ignored')
     )
  ) THEN
    RAISE EXCEPTION 'Xero connection delivery has an unhandled stream' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT delivered.created,delivered.disposition
    FROM control_plane.record_xero_webhook_connection_delivery(
      document->>'tenantId',document->>'connectionId',document->>'inboxId',streams
    ) AS delivered;
END;
$$;

REVOKE ALL ON FUNCTION
  control_plane.record_attested_xero_webhook_connection_delivery(text,bigint,text,text,text)
FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION
  control_plane.record_attested_xero_webhook_connection_delivery(text,bigint,text,text,text)
TO albert_webhook_control;

COMMIT;
