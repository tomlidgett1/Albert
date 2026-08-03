BEGIN;

-- Encrypted Xero payloads can contain accounting identifiers from more than
-- one Xero organisation. They are therefore deliberately much shorter-lived
-- than the provider's replay horizon. Durable receipts, scheduled polling and
-- reconciliation sweeps provide completeness without retaining source bodies.

DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT constraint_definition.conname,
           pg_get_constraintdef(constraint_definition.oid) AS definition
      FROM pg_constraint AS constraint_definition
     WHERE constraint_definition.conrelid =
             'control_plane.xero_webhook_inbox'::regclass
       AND constraint_definition.contype = 'c'
  LOOP
    IF (
      constraint_row.definition ILIKE '%expires_at%'
      AND constraint_row.definition ILIKE '%first_received_at%'
    ) OR (
      constraint_row.definition ILIKE '%retain_until%'
      AND constraint_row.definition ILIKE '%first_received_at%'
    ) OR (
      constraint_row.definition ILIKE '%ciphertext%'
      AND constraint_row.definition ILIKE '%nonce%'
      AND constraint_row.definition ILIKE '%auth_tag%'
      AND constraint_row.definition ILIKE '%processed%'
      AND constraint_row.definition ILIKE '%expired%'
    ) THEN
      EXECUTE format(
        'ALTER TABLE control_plane.xero_webhook_inbox DROP CONSTRAINT %I',
        constraint_row.conname
      );
    END IF;
  END LOOP;
END;
$$;

-- Apply the new cryptographic and metadata deadlines to existing rows. A
-- terminal failure is useful only as bounded operational metadata; keeping its
-- source payload would turn an operator workflow into an unbounded data store.
UPDATE control_plane.xero_webhook_inbox AS item
   SET expires_at = item.first_received_at + interval '3 days',
       retain_until = item.first_received_at + interval '14 days',
       status = CASE
         WHEN item.status IN ('pending', 'processing', 'retry_wait')
          AND item.first_received_at + interval '3 days' <= clock_timestamp()
           THEN 'expired'
         ELSE item.status
       END,
       lease_owner = CASE
         WHEN item.status IN ('pending', 'processing', 'retry_wait')
          AND item.first_received_at + interval '3 days' <= clock_timestamp()
           THEN NULL
         ELSE item.lease_owner
       END,
       lease_expires_at = CASE
         WHEN item.status IN ('pending', 'processing', 'retry_wait')
          AND item.first_received_at + interval '3 days' <= clock_timestamp()
           THEN NULL
         ELSE item.lease_expires_at
       END,
       ciphertext = CASE
         WHEN item.status IN ('processed', 'expired', 'failed')
           OR item.first_received_at + interval '3 days' <= clock_timestamp()
           THEN NULL
         ELSE item.ciphertext
       END,
       nonce = CASE
         WHEN item.status IN ('processed', 'expired', 'failed')
           OR item.first_received_at + interval '3 days' <= clock_timestamp()
           THEN NULL
         ELSE item.nonce
       END,
       auth_tag = CASE
         WHEN item.status IN ('processed', 'expired', 'failed')
           OR item.first_received_at + interval '3 days' <= clock_timestamp()
           THEN NULL
         ELSE item.auth_tag
       END,
       last_error_code = CASE
         WHEN item.status IN ('pending', 'processing', 'retry_wait')
          AND item.first_received_at + interval '3 days' <= clock_timestamp()
           THEN 'inbox_retention_expired'
         ELSE item.last_error_code
       END;

ALTER TABLE control_plane.xero_webhook_inbox
  ADD CONSTRAINT xero_webhook_inbox_encrypted_retention_check
    CHECK (
      expires_at >= first_received_at + interval '1 day'
      AND expires_at <= first_received_at + interval '7 days'
    ),
  ADD CONSTRAINT xero_webhook_inbox_metadata_retention_check
    CHECK (
      retain_until >= expires_at
      AND retain_until <= first_received_at + interval '30 days'
    ),
  ADD CONSTRAINT xero_webhook_inbox_ciphertext_lifecycle_check
    CHECK (
      (
        status IN ('processed', 'expired', 'failed')
        AND ciphertext IS NULL
        AND nonce IS NULL
        AND auth_tag IS NULL
      )
      OR
      (
        status IN ('pending', 'processing', 'retry_wait')
        AND ciphertext IS NOT NULL
        AND octet_length(ciphertext) = body_bytes
        AND nonce IS NOT NULL
        AND octet_length(nonce) = 12
        AND auth_tag IS NOT NULL
        AND octet_length(auth_tag) = 16
      )
    );

CREATE OR REPLACE FUNCTION control_plane.fail_xero_webhook_inbox(
  p_inbox_id text,
  p_worker_id text,
  p_error_code text,
  p_retry_delay_seconds integer,
  p_max_attempts integer,
  p_permanent boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  item record;
  next_status text;
BEGIN
  IF p_inbox_id IS NULL
     OR p_worker_id IS NULL
     OR p_error_code IS NULL
     OR p_retry_delay_seconds IS NULL
     OR p_max_attempts IS NULL
     OR p_permanent IS NULL
     OR p_error_code !~ '^[a-z][a-z0-9_.-]{0,79}$'
     OR p_retry_delay_seconds NOT BETWEEN 1 AND 86400
     OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'xero webhook failure evidence is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT inbox.attempt_count, inbox.expires_at INTO item
    FROM control_plane.xero_webhook_inbox AS inbox
   WHERE inbox.inbox_id = p_inbox_id
     AND inbox.status = 'processing'
     AND inbox.lease_owner = p_worker_id
     AND inbox.lease_expires_at > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'xero webhook lease is not owned' USING ERRCODE = '55000';
  END IF;

  next_status := CASE
    WHEN item.expires_at <= clock_timestamp() THEN 'expired'
    WHEN p_permanent OR item.attempt_count >= p_max_attempts THEN 'failed'
    ELSE 'retry_wait'
  END;

  UPDATE control_plane.xero_webhook_inbox
     SET status = next_status,
         lease_owner = NULL,
         lease_expires_at = NULL,
         next_attempt_at = clock_timestamp() + make_interval(secs => p_retry_delay_seconds),
         last_error_code = p_error_code,
         ciphertext = CASE
           WHEN next_status IN ('expired', 'failed') THEN NULL
           ELSE ciphertext
         END,
         nonce = CASE
           WHEN next_status IN ('expired', 'failed') THEN NULL
           ELSE nonce
         END,
         auth_tag = CASE
           WHEN next_status IN ('expired', 'failed') THEN NULL
           ELSE auth_tag
         END
   WHERE inbox_id = p_inbox_id;

  RETURN next_status;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.xero_webhook_inbox_health()
RETURNS TABLE (
  pending_count bigint,
  processing_count bigint,
  retry_count bigint,
  failed_count bigint,
  expired_count bigint,
  oldest_unprocessed_at timestamptz,
  active_key_ids text[]
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
  SELECT
    count(*) FILTER (WHERE status = 'pending'),
    count(*) FILTER (WHERE status = 'processing'),
    count(*) FILTER (WHERE status = 'retry_wait'),
    count(*) FILTER (WHERE status = 'failed'),
    count(*) FILTER (WHERE status = 'expired'),
    min(first_received_at) FILTER (WHERE status IN ('pending', 'processing', 'retry_wait')),
    coalesce(
      array_agg(DISTINCT encryption_key_id ORDER BY encryption_key_id)
        FILTER (WHERE status IN ('pending', 'processing', 'retry_wait')),
      ARRAY[]::text[]
    )
  FROM control_plane.xero_webhook_inbox;
$$;

REVOKE ALL ON FUNCTION control_plane.fail_xero_webhook_inbox(
  text, text, text, integer, integer, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.xero_webhook_inbox_health()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION control_plane.fail_xero_webhook_inbox(
  text, text, text, integer, integer, boolean
) TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.xero_webhook_inbox_health()
  TO albert_webhook_control;

-- The bootstrap-owned fixed wrapper schedules this as postgres, rather than
-- as the NOLOGIN migration owner. Retention therefore does not depend on the
-- gateway process remaining healthy.
SELECT extensions.albert_install_xero_inbox_retention_cron_job();

COMMIT;
