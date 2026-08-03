BEGIN;

-- Xero delivers one app-wide webhook that may contain events for multiple
-- organisations. The public request path therefore cannot resolve an Albert
-- tenant before acknowledging Xero. It stores only this encrypted, bounded,
-- tenant-neutral inbox item; tenant routing happens under a lease afterwards.

CREATE TABLE IF NOT EXISTS control_plane.xero_webhook_inbox_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.xero_webhook_inbox_status_lookup (status, description) VALUES
  ('pending', 'A signature-verified encrypted payload is ready to claim'),
  ('processing', 'A gateway worker owns a time-bounded processing lease'),
  ('retry_wait', 'A retryable processing failure is waiting for its next attempt'),
  ('processed', 'All matching partitions were durably routed and ciphertext was erased'),
  ('failed', 'A permanent or exhausted failure requires operator intervention'),
  ('expired', 'The unprocessed payload exceeded the bounded encrypted retention window')
ON CONFLICT (status) DO NOTHING;

CREATE TABLE IF NOT EXISTS control_plane.xero_webhook_inbox (
  inbox_id text PRIMARY KEY CHECK (control_plane.is_ulid(inbox_id)),
  body_sha256 text NOT NULL UNIQUE CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  encryption_key_id text NOT NULL CHECK (encryption_key_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  nonce bytea,
  ciphertext bytea,
  auth_tag bytea,
  body_bytes integer NOT NULL CHECK (body_bytes BETWEEN 1 AND 1048576),
  first_event_sequence integer NOT NULL CHECK (first_event_sequence BETWEEN 0 AND 2147483647),
  last_event_sequence integer NOT NULL CHECK (last_event_sequence BETWEEN 0 AND 2147483647),
  event_count integer NOT NULL CHECK (event_count BETWEEN 0 AND 1000),
  delivery_count integer NOT NULL DEFAULT 1 CHECK (delivery_count > 0),
  status text NOT NULL DEFAULT 'pending'
    REFERENCES control_plane.xero_webhook_inbox_status_lookup(status),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner text CHECK (lease_owner IS NULL OR length(btrim(lease_owner)) BETWEEN 1 AND 160),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  first_received_at timestamptz NOT NULL,
  last_received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  processed_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_.-]{0,79}$'
  ),
  route_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (event_count = 0 AND first_event_sequence = 0 AND last_event_sequence = 0)
    OR
    (event_count > 0 AND first_event_sequence > 0 AND last_event_sequence >= first_event_sequence)
  ),
  CHECK (last_received_at >= first_received_at),
  CHECK (expires_at >= first_received_at + interval '31 days'),
  CHECK (expires_at <= first_received_at + interval '35 days'),
  CHECK (retain_until >= expires_at AND retain_until <= first_received_at + interval '45 days'),
  CHECK (jsonb_typeof(route_summary) = 'object'),
  CHECK (octet_length(route_summary::text) <= 4096),
  CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status IN ('processed', 'expired') AND ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL)
    OR
    (status NOT IN ('processed', 'expired')
      AND ciphertext IS NOT NULL AND octet_length(ciphertext) = body_bytes
      AND nonce IS NOT NULL AND octet_length(nonce) = 12
      AND auth_tag IS NOT NULL AND octet_length(auth_tag) = 16)
  ),
  CHECK ((status = 'processed') = (processed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS xero_webhook_inbox_claim_idx
  ON control_plane.xero_webhook_inbox (status, next_attempt_at, first_received_at)
  WHERE status IN ('pending', 'processing', 'retry_wait');
CREATE INDEX IF NOT EXISTS xero_webhook_inbox_retention_idx
  ON control_plane.xero_webhook_inbox (retain_until)
  WHERE status IN ('processed', 'failed', 'expired');
CREATE INDEX IF NOT EXISTS xero_webhook_inbox_expiry_idx
  ON control_plane.xero_webhook_inbox (expires_at)
  WHERE status IN ('pending', 'processing', 'retry_wait', 'failed');

CREATE TABLE IF NOT EXISTS control_plane.xero_webhook_sequence_disposition_lookup (
  disposition text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.xero_webhook_sequence_disposition_lookup
  (disposition, description) VALUES
  ('intent', 'Xero intent-to-receive validation payload'),
  ('initial', 'First live delivery observed by this webhook endpoint'),
  ('contiguous', 'Delivery begins immediately after the prior sequence'),
  ('gap', 'One or more sequence numbers were not delivered before this payload'),
  ('overlap', 'Delivery overlaps the high-water mark and also advances it'),
  ('out_of_order', 'Delivery is wholly at or below the high-water mark')
ON CONFLICT (disposition) DO NOTHING;

CREATE TABLE IF NOT EXISTS control_plane.xero_webhook_sequence_state (
  sequence_scope text PRIMARY KEY CHECK (sequence_scope = 'xero'),
  first_event_sequence integer NOT NULL CHECK (first_event_sequence > 0),
  last_event_sequence integer NOT NULL CHECK (last_event_sequence >= first_event_sequence),
  delivery_count bigint NOT NULL DEFAULT 1 CHECK (delivery_count > 0),
  gap_count bigint NOT NULL DEFAULT 0 CHECK (gap_count >= 0),
  overlap_count bigint NOT NULL DEFAULT 0 CHECK (overlap_count >= 0),
  out_of_order_count bigint NOT NULL DEFAULT 0 CHECK (out_of_order_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control_plane.xero_webhook_sequence_observations (
  inbox_id text PRIMARY KEY
    REFERENCES control_plane.xero_webhook_inbox(inbox_id) ON DELETE CASCADE,
  first_event_sequence integer NOT NULL CHECK (first_event_sequence >= 0),
  last_event_sequence integer NOT NULL CHECK (last_event_sequence >= first_event_sequence),
  disposition text NOT NULL
    REFERENCES control_plane.xero_webhook_sequence_disposition_lookup(disposition),
  gap_first_sequence integer,
  gap_last_sequence integer,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (disposition = 'gap'
      AND gap_first_sequence IS NOT NULL
      AND gap_last_sequence IS NOT NULL
      AND gap_last_sequence >= gap_first_sequence)
    OR
    (disposition <> 'gap' AND gap_first_sequence IS NULL AND gap_last_sequence IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS control_plane.xero_webhook_gap_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO control_plane.xero_webhook_gap_status_lookup (status, description) VALUES
  ('detected', 'A sequence gap was durably detected'),
  ('enqueued', 'Idempotent reconciliation sweeps were enqueued for active Xero connections')
ON CONFLICT (status) DO NOTHING;

CREATE TABLE IF NOT EXISTS control_plane.xero_webhook_gaps (
  gap_id text PRIMARY KEY CHECK (control_plane.is_ulid(gap_id)),
  source_inbox_id text REFERENCES control_plane.xero_webhook_inbox(inbox_id) ON DELETE SET NULL,
  missing_first_sequence integer NOT NULL CHECK (missing_first_sequence > 0),
  missing_last_sequence integer NOT NULL CHECK (missing_last_sequence >= missing_first_sequence),
  status text NOT NULL DEFAULT 'detected'
    REFERENCES control_plane.xero_webhook_gap_status_lookup(status),
  sweep_count integer NOT NULL DEFAULT 0 CHECK (sweep_count >= 0),
  detected_at timestamptz NOT NULL DEFAULT now(),
  enqueued_at timestamptz,
  UNIQUE (missing_first_sequence, missing_last_sequence),
  CHECK ((status = 'enqueued') = (enqueued_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS control_plane.xero_webhook_connection_sequences (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  first_event_sequence integer NOT NULL CHECK (first_event_sequence > 0),
  last_event_sequence integer NOT NULL CHECK (last_event_sequence >= first_event_sequence),
  delivered_payload_count bigint NOT NULL DEFAULT 1 CHECK (delivered_payload_count > 0),
  overlap_count bigint NOT NULL DEFAULT 0 CHECK (overlap_count >= 0),
  out_of_order_count bigint NOT NULL DEFAULT 0 CHECK (out_of_order_count >= 0),
  gap_count bigint NOT NULL DEFAULT 0 CHECK (gap_count >= 0),
  last_inbox_id text REFERENCES control_plane.xero_webhook_inbox(inbox_id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_plane.xero_webhook_connection_deliveries (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  inbox_id text NOT NULL REFERENCES control_plane.xero_webhook_inbox(inbox_id) ON DELETE CASCADE,
  first_event_sequence integer NOT NULL CHECK (first_event_sequence > 0),
  last_event_sequence integer NOT NULL CHECK (last_event_sequence >= first_event_sequence),
  streams text[] NOT NULL CHECK (
    cardinality(streams) BETWEEN 1 AND 3
    AND streams <@ ARRAY['contacts', 'credit_notes', 'invoices']::text[]
  ),
  disposition text NOT NULL
    REFERENCES control_plane.xero_webhook_sequence_disposition_lookup(disposition),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, inbox_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS control_plane.xero_webhook_gap_recoveries (
  gap_id text NOT NULL REFERENCES control_plane.xero_webhook_gaps(gap_id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  stream text NOT NULL CHECK (stream IN ('contacts', 'invoices', 'credit_notes')),
  job_request_id text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gap_id, tenant_id, connection_id, stream),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_request_id)
    REFERENCES control_plane.sync_job_requests(tenant_id, job_request_id) ON DELETE CASCADE
);

ALTER TABLE control_plane.xero_webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.xero_webhook_sequence_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.xero_webhook_sequence_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.xero_webhook_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.xero_webhook_connection_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.xero_webhook_connection_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.xero_webhook_gap_recoveries ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS xero_webhook_inbox_touch_updated_at
  ON control_plane.xero_webhook_inbox;
CREATE TRIGGER xero_webhook_inbox_touch_updated_at
  BEFORE UPDATE ON control_plane.xero_webhook_inbox
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

CREATE OR REPLACE FUNCTION control_plane.accept_xero_webhook_inbox(
  p_inbox_id text,
  p_body_sha256 text,
  p_encryption_key_id text,
  p_nonce bytea,
  p_ciphertext bytea,
  p_auth_tag bytea,
  p_body_bytes integer,
  p_first_event_sequence integer,
  p_last_event_sequence integer,
  p_event_count integer,
  p_received_at timestamptz,
  p_expires_at timestamptz,
  p_retain_until timestamptz
)
RETURNS TABLE (
  inbox_id text,
  status text,
  created boolean,
  delivery_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  inserted_id text;
  existing record;
BEGIN
  IF p_received_at IS NULL
     OR p_received_at < clock_timestamp() - interval '5 minutes'
     OR p_received_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'xero webhook receive time is invalid' USING ERRCODE = '22023';
  END IF;
  INSERT INTO control_plane.xero_webhook_inbox (
    inbox_id, body_sha256, encryption_key_id, nonce, ciphertext, auth_tag,
    body_bytes, first_event_sequence, last_event_sequence, event_count,
    first_received_at, last_received_at, expires_at, retain_until
  ) VALUES (
    p_inbox_id, p_body_sha256, p_encryption_key_id, p_nonce, p_ciphertext, p_auth_tag,
    p_body_bytes, p_first_event_sequence, p_last_event_sequence, p_event_count,
    p_received_at, p_received_at, p_expires_at, p_retain_until
  )
  ON CONFLICT (body_sha256) DO NOTHING
  RETURNING xero_webhook_inbox.inbox_id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN
    RETURN QUERY SELECT inserted_id, 'pending'::text, true, 1;
    RETURN;
  END IF;

  SELECT item.* INTO existing
  FROM control_plane.xero_webhook_inbox AS item
  WHERE item.body_sha256 = p_body_sha256
  FOR UPDATE;
  IF existing.inbox_id IS NULL
     OR existing.body_bytes <> p_body_bytes
     OR existing.first_event_sequence <> p_first_event_sequence
     OR existing.last_event_sequence <> p_last_event_sequence
     OR existing.event_count <> p_event_count THEN
    RAISE EXCEPTION 'xero webhook body hash collision' USING ERRCODE = '22000';
  END IF;
  UPDATE control_plane.xero_webhook_inbox AS item
     SET delivery_count = item.delivery_count + 1,
         last_received_at = greatest(item.last_received_at, p_received_at)
   WHERE item.inbox_id = existing.inbox_id
   RETURNING item.inbox_id, item.status, false, item.delivery_count
   INTO inbox_id, status, created, delivery_count;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.claim_xero_webhook_inbox(
  p_worker_id text,
  p_limit integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 90
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
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_worker_id IS NULL
     OR p_limit IS NULL
     OR p_lease_seconds IS NULL
     OR length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_limit NOT BETWEEN 1 AND 10
     OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'xero webhook claim is invalid' USING ERRCODE = '22023';
  END IF;

  WITH expired_candidates AS (
    SELECT item.inbox_id
      FROM control_plane.xero_webhook_inbox AS item
     WHERE item.expires_at <= clock_timestamp()
       AND item.status IN ('pending', 'processing', 'retry_wait', 'failed')
     ORDER BY item.expires_at, item.inbox_id
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE control_plane.xero_webhook_inbox AS expired
     SET status = 'expired', lease_owner = NULL, lease_expires_at = NULL,
         ciphertext = NULL, nonce = NULL, auth_tag = NULL,
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
         OR
         (item.status = 'processing' AND item.lease_expires_at <= clock_timestamp())
       )
     ORDER BY item.first_received_at, item.inbox_id
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  ), claimed AS (
    UPDATE control_plane.xero_webhook_inbox AS item
       SET status = 'processing', lease_owner = p_worker_id,
           lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
           attempt_count = item.attempt_count + 1,
           last_error_code = NULL
      FROM candidates
     WHERE item.inbox_id = candidates.inbox_id
    RETURNING item.*
  )
  SELECT claimed.inbox_id, claimed.body_sha256, claimed.encryption_key_id,
         claimed.nonce, claimed.ciphertext, claimed.auth_tag, claimed.body_bytes,
         claimed.first_event_sequence, claimed.last_event_sequence,
         claimed.event_count, claimed.first_received_at, claimed.attempt_count
    FROM claimed
   ORDER BY claimed.first_received_at, claimed.inbox_id;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.renew_xero_webhook_inbox_lease(
  p_inbox_id text,
  p_worker_id text,
  p_lease_seconds integer DEFAULT 90
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  renewed boolean;
BEGIN
  IF p_inbox_id IS NULL
     OR p_worker_id IS NULL
     OR length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_lease_seconds IS NULL
     OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'xero webhook lease is invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.xero_webhook_inbox AS item
     SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
   WHERE item.inbox_id = p_inbox_id
     AND item.status = 'processing'
     AND item.lease_owner = p_worker_id
     AND item.lease_expires_at > clock_timestamp()
  RETURNING true INTO renewed;
  RETURN coalesce(renewed, false);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.record_xero_webhook_sequence(
  p_inbox_id text,
  p_worker_id text
)
RETURNS TABLE (
  disposition text,
  gap_id text,
  gap_first_sequence integer,
  gap_last_sequence integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  item record;
  existing record;
  state record;
  selected_disposition text;
  selected_gap_id text;
  selected_gap_first integer;
  selected_gap_last integer;
BEGIN
  SELECT inbox.first_event_sequence, inbox.last_event_sequence, inbox.event_count
    INTO item
    FROM control_plane.xero_webhook_inbox AS inbox
   WHERE inbox.inbox_id = p_inbox_id
     AND inbox.status = 'processing'
     AND inbox.lease_owner = p_worker_id
     AND inbox.lease_expires_at > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'xero webhook lease is not owned' USING ERRCODE = '55000';
  END IF;

  SELECT observation.disposition, gap.gap_id,
         observation.gap_first_sequence, observation.gap_last_sequence
    INTO existing
    FROM control_plane.xero_webhook_sequence_observations AS observation
    LEFT JOIN control_plane.xero_webhook_gaps AS gap
      ON gap.source_inbox_id = observation.inbox_id
   WHERE observation.inbox_id = p_inbox_id;
  IF FOUND THEN
    RETURN QUERY SELECT existing.disposition, existing.gap_id,
                        existing.gap_first_sequence, existing.gap_last_sequence;
    RETURN;
  END IF;

  IF item.event_count = 0 THEN
    selected_disposition := 'intent';
  ELSE
    SELECT sequence.* INTO state
      FROM control_plane.xero_webhook_sequence_state AS sequence
     WHERE sequence.sequence_scope = 'xero'
     FOR UPDATE;
    IF NOT FOUND THEN
      selected_disposition := 'initial';
      INSERT INTO control_plane.xero_webhook_sequence_state (
        sequence_scope, first_event_sequence, last_event_sequence
      ) VALUES ('xero', item.first_event_sequence, item.last_event_sequence);
    ELSIF item.last_event_sequence <= state.last_event_sequence THEN
      selected_disposition := 'out_of_order';
      UPDATE control_plane.xero_webhook_sequence_state
         SET first_event_sequence = least(first_event_sequence, item.first_event_sequence),
             delivery_count = delivery_count + 1,
             out_of_order_count = out_of_order_count + 1,
             updated_at = clock_timestamp()
       WHERE sequence_scope = 'xero';
    ELSIF item.first_event_sequence <= state.last_event_sequence THEN
      selected_disposition := 'overlap';
      UPDATE control_plane.xero_webhook_sequence_state
         SET first_event_sequence = least(first_event_sequence, item.first_event_sequence),
             last_event_sequence = item.last_event_sequence,
             delivery_count = delivery_count + 1,
             overlap_count = overlap_count + 1,
             updated_at = clock_timestamp()
       WHERE sequence_scope = 'xero';
    ELSIF item.first_event_sequence = state.last_event_sequence + 1 THEN
      selected_disposition := 'contiguous';
      UPDATE control_plane.xero_webhook_sequence_state
         SET last_event_sequence = item.last_event_sequence,
             delivery_count = delivery_count + 1,
             updated_at = clock_timestamp()
       WHERE sequence_scope = 'xero';
    ELSE
      selected_disposition := 'gap';
      selected_gap_first := state.last_event_sequence + 1;
      selected_gap_last := item.first_event_sequence - 1;
      UPDATE control_plane.xero_webhook_sequence_state
         SET last_event_sequence = item.last_event_sequence,
             delivery_count = delivery_count + 1,
             gap_count = gap_count + 1,
             updated_at = clock_timestamp()
       WHERE sequence_scope = 'xero';
      INSERT INTO control_plane.xero_webhook_gaps (
        gap_id, source_inbox_id, missing_first_sequence, missing_last_sequence
      ) VALUES (
        control_plane.generate_ulid(), p_inbox_id, selected_gap_first, selected_gap_last
      )
      ON CONFLICT (missing_first_sequence, missing_last_sequence) DO UPDATE
        SET source_inbox_id = coalesce(control_plane.xero_webhook_gaps.source_inbox_id, EXCLUDED.source_inbox_id)
      RETURNING xero_webhook_gaps.gap_id INTO selected_gap_id;
    END IF;
  END IF;

  INSERT INTO control_plane.xero_webhook_sequence_observations (
    inbox_id, first_event_sequence, last_event_sequence, disposition,
    gap_first_sequence, gap_last_sequence
  ) VALUES (
    p_inbox_id, item.first_event_sequence, item.last_event_sequence,
    selected_disposition, selected_gap_first, selected_gap_last
  );
  RETURN QUERY SELECT selected_disposition, selected_gap_id,
                      selected_gap_first, selected_gap_last;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.record_xero_webhook_connection_delivery(
  p_tenant_id text,
  p_connection_id text,
  p_inbox_id text,
  p_streams text[]
)
RETURNS TABLE (created boolean, disposition text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  observation record;
  prior record;
  selected_disposition text;
  inserted boolean;
BEGIN
  IF p_streams IS NULL
     OR cardinality(p_streams) NOT BETWEEN 1 AND 3
     OR array_position(p_streams, NULL) IS NOT NULL
     OR NOT (p_streams <@ ARRAY['contacts', 'credit_notes', 'invoices']::text[]) THEN
    RAISE EXCEPTION 'xero webhook streams are invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM control_plane.connections AS connection
   WHERE connection.tenant_id = p_tenant_id
     AND connection.connection_id = p_connection_id
     AND connection.connector_key = 'xero'
     AND connection.status IN ('connected', 'degraded')
     AND connection.external_account_reference IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active xero connection was not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT item.first_event_sequence, item.last_event_sequence,
         sequence.disposition AS global_disposition
    INTO observation
    FROM control_plane.xero_webhook_inbox AS item
    JOIN control_plane.xero_webhook_sequence_observations AS sequence
      ON sequence.inbox_id = item.inbox_id
   WHERE item.inbox_id = p_inbox_id;
  IF NOT FOUND OR observation.first_event_sequence = 0 THEN
    RAISE EXCEPTION 'live xero webhook sequence was not recorded' USING ERRCODE = '55000';
  END IF;

  SELECT state.* INTO prior
    FROM control_plane.xero_webhook_connection_sequences AS state
   WHERE state.tenant_id = p_tenant_id AND state.connection_id = p_connection_id
   FOR UPDATE;
  IF NOT FOUND THEN
    selected_disposition := CASE
      WHEN observation.global_disposition = 'gap' THEN 'gap'
      ELSE 'initial'
    END;
  ELSIF observation.last_event_sequence <= prior.last_event_sequence THEN
    selected_disposition := 'out_of_order';
  ELSIF observation.first_event_sequence <= prior.last_event_sequence THEN
    selected_disposition := 'overlap';
  ELSIF observation.global_disposition = 'gap' THEN
    selected_disposition := 'gap';
  ELSE
    selected_disposition := 'contiguous';
  END IF;

  INSERT INTO control_plane.xero_webhook_connection_deliveries (
    tenant_id, connection_id, inbox_id, first_event_sequence,
    last_event_sequence, streams, disposition
  ) VALUES (
    p_tenant_id, p_connection_id, p_inbox_id, observation.first_event_sequence,
    observation.last_event_sequence, ARRAY(SELECT DISTINCT unnest(p_streams) ORDER BY 1),
    selected_disposition
  )
  ON CONFLICT (tenant_id, connection_id, inbox_id) DO NOTHING
  RETURNING true INTO inserted;
  IF NOT coalesce(inserted, false) THEN
    SELECT delivery.disposition INTO selected_disposition
      FROM control_plane.xero_webhook_connection_deliveries AS delivery
     WHERE delivery.tenant_id = p_tenant_id
       AND delivery.connection_id = p_connection_id
       AND delivery.inbox_id = p_inbox_id;
    RETURN QUERY SELECT false, selected_disposition;
    RETURN;
  END IF;

  INSERT INTO control_plane.xero_webhook_connection_sequences (
    tenant_id, connection_id, first_event_sequence, last_event_sequence,
    overlap_count, out_of_order_count, gap_count, last_inbox_id
  ) VALUES (
    p_tenant_id, p_connection_id, observation.first_event_sequence,
    observation.last_event_sequence,
    CASE WHEN selected_disposition = 'overlap' THEN 1 ELSE 0 END,
    CASE WHEN selected_disposition = 'out_of_order' THEN 1 ELSE 0 END,
    CASE WHEN selected_disposition = 'gap' THEN 1 ELSE 0 END,
    p_inbox_id
  )
  ON CONFLICT (tenant_id, connection_id) DO UPDATE
    SET first_event_sequence = least(
          control_plane.xero_webhook_connection_sequences.first_event_sequence,
          EXCLUDED.first_event_sequence
        ),
        last_event_sequence = greatest(
          control_plane.xero_webhook_connection_sequences.last_event_sequence,
          EXCLUDED.last_event_sequence
        ),
        delivered_payload_count = control_plane.xero_webhook_connection_sequences.delivered_payload_count + 1,
        overlap_count = control_plane.xero_webhook_connection_sequences.overlap_count
          + CASE WHEN selected_disposition = 'overlap' THEN 1 ELSE 0 END,
        out_of_order_count = control_plane.xero_webhook_connection_sequences.out_of_order_count
          + CASE WHEN selected_disposition = 'out_of_order' THEN 1 ELSE 0 END,
        gap_count = control_plane.xero_webhook_connection_sequences.gap_count
          + CASE WHEN selected_disposition = 'gap' THEN 1 ELSE 0 END,
        last_inbox_id = EXCLUDED.last_inbox_id,
        updated_at = clock_timestamp();
  RETURN QUERY SELECT true, selected_disposition;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.enqueue_xero_webhook_incremental(
  p_tenant_id text,
  p_connection_id text,
  p_inbox_id text,
  p_webhook_receipt_id text,
  p_stream text,
  p_received_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  connection record;
  receipt record;
BEGIN
  IF p_stream IS NULL
     OR p_received_at IS NULL
     OR p_stream NOT IN ('contacts', 'invoices', 'credit_notes') THEN
    RAISE EXCEPTION 'xero webhook stream is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT item.connector_key, item.external_account_reference
    INTO connection
    FROM control_plane.connections AS item
   WHERE item.tenant_id = p_tenant_id
     AND item.connection_id = p_connection_id
     AND item.connector_key = 'xero'
     AND item.status IN ('connected', 'degraded')
     AND item.external_account_reference IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active xero connection was not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT webhook.status, webhook.raw_object_key
    INTO receipt
    FROM control_plane.webhook_receipts AS webhook
   WHERE webhook.tenant_id = p_tenant_id
     AND webhook.connection_id = p_connection_id
     AND webhook.webhook_receipt_id = p_webhook_receipt_id
     AND webhook.connector_key = 'xero'
     AND webhook.dedupe_key = 'xero:' || p_inbox_id || ':' || p_stream
   FOR UPDATE;
  IF NOT FOUND OR receipt.raw_object_key IS NULL THEN
    RAISE EXCEPTION 'xero webhook raw receipt is incomplete' USING ERRCODE = '55000';
  END IF;

  PERFORM control_plane.enqueue_sync_job(
    jsonb_build_object(
      'schemaVersion', 1,
      'type', 'IncrementalSync',
      'tenantId', p_tenant_id,
      'connectionId', p_connection_id,
      'connectorId', 'xero',
      'externalAccountReference', connection.external_account_reference,
      'syncRunId', control_plane.generate_ulid(),
      'batchId', control_plane.generate_ulid(),
      'requestedAt', p_received_at,
      'stream', p_stream,
      'reason', 'webhook',
      'webhookReceiptId', p_webhook_receipt_id
    ),
    'high',
    'xero-webhook:' || p_inbox_id || ':' || p_connection_id || ':' || p_stream,
    0
  );
  UPDATE control_plane.webhook_receipts AS webhook
     SET status = 'queued', routed_streams = ARRAY[p_stream],
         queued_at = coalesce(webhook.queued_at, clock_timestamp())
   WHERE webhook.tenant_id = p_tenant_id
     AND webhook.webhook_receipt_id = p_webhook_receipt_id;
  RETURN receipt.status <> 'queued';
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.enqueue_xero_webhook_gap_sweeps(
  p_gap_id text,
  p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  gap record;
  candidate record;
  stream_name text;
  request record;
  enqueued_count integer := 0;
BEGIN
  IF p_gap_id IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'xero webhook gap sweep input is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT item.* INTO gap
    FROM control_plane.xero_webhook_gaps AS item
   WHERE item.gap_id = p_gap_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'xero webhook gap was not found' USING ERRCODE = 'P0002';
  END IF;
  IF gap.status = 'enqueued' THEN RETURN gap.sweep_count; END IF;

  FOR candidate IN
    SELECT connection.tenant_id, connection.connection_id,
           connection.external_account_reference
      FROM control_plane.connections AS connection
     WHERE connection.connector_key = 'xero'
       AND connection.status IN ('connected', 'degraded')
       AND connection.external_account_reference IS NOT NULL
     ORDER BY connection.tenant_id, connection.connection_id
  LOOP
    FOREACH stream_name IN ARRAY ARRAY['contacts', 'invoices', 'credit_notes']::text[] LOOP
      SELECT * INTO request
        FROM control_plane.enqueue_sync_job(
          jsonb_build_object(
            'schemaVersion', 1,
            'type', 'ReconciliationSweep',
            'tenantId', candidate.tenant_id,
            'connectionId', candidate.connection_id,
            'connectorId', 'xero',
            'externalAccountReference', candidate.external_account_reference,
            'syncRunId', control_plane.generate_ulid(),
            'batchId', control_plane.generate_ulid(),
            'requestedAt', p_now,
            'stream', stream_name,
            'lookbackFrom', p_now - interval '32 days',
            'lookbackTo', p_now,
            'reason', 'webhook_sequence_gap',
            'webhookGapId', p_gap_id
          ),
          'standard',
          'xero-gap:' || gap.missing_first_sequence || ':' || gap.missing_last_sequence
            || ':' || candidate.connection_id || ':' || stream_name,
          0
        );
      INSERT INTO control_plane.xero_webhook_gap_recoveries (
        gap_id, tenant_id, connection_id, stream, job_request_id
      ) VALUES (
        p_gap_id, candidate.tenant_id, candidate.connection_id, stream_name,
        request.job_request_id
      ) ON CONFLICT (gap_id, tenant_id, connection_id, stream) DO NOTHING;
      enqueued_count := enqueued_count + 1;
    END LOOP;
  END LOOP;
  UPDATE control_plane.xero_webhook_gaps
     SET status = 'enqueued', sweep_count = enqueued_count,
         enqueued_at = clock_timestamp()
   WHERE gap_id = p_gap_id;
  RETURN enqueued_count;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_xero_webhook_inbox(
  p_inbox_id text,
  p_worker_id text,
  p_route_summary jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_route_summary IS NULL OR jsonb_typeof(p_route_summary) <> 'object'
     OR octet_length(p_route_summary::text) > 4096
     OR NOT (p_route_summary ?& ARRAY[
       'partitionCount', 'matchedConnectionCount', 'routedStreamCount',
       'unmatchedPartitionCount', 'ignoredEventCount',
       'sequenceDisposition', 'gapRecoveryCount'
     ])
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_route_summary) AS key(name)
        WHERE key.name NOT IN (
          'partitionCount', 'matchedConnectionCount', 'routedStreamCount',
          'unmatchedPartitionCount', 'ignoredEventCount',
          'sequenceDisposition', 'gapRecoveryCount'
        )
     )
     OR jsonb_typeof(p_route_summary -> 'sequenceDisposition') <> 'string'
     OR p_route_summary ->> 'sequenceDisposition' NOT IN (
       'intent', 'initial', 'contiguous', 'gap', 'overlap', 'out_of_order'
     )
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_route_summary) AS field(name, value)
        WHERE field.name IN (
          'partitionCount', 'matchedConnectionCount', 'routedStreamCount',
          'unmatchedPartitionCount', 'ignoredEventCount', 'gapRecoveryCount'
        )
          AND (
            jsonb_typeof(field.value) <> 'number'
            OR field.value::text !~ '^[0-9]{1,9}$'
          )
     ) THEN
    RAISE EXCEPTION 'xero webhook route summary is invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.xero_webhook_inbox AS item
     SET status = 'processed', processed_at = clock_timestamp(),
         route_summary = p_route_summary, ciphertext = NULL, nonce = NULL,
         auth_tag = NULL, lease_owner = NULL, lease_expires_at = NULL,
         last_error_code = NULL
   WHERE item.inbox_id = p_inbox_id
     AND item.status = 'processing'
     AND item.lease_owner = p_worker_id
     AND item.lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'xero webhook lease is not owned' USING ERRCODE = '55000';
  END IF;
END;
$$;

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
     SET status = next_status, lease_owner = NULL, lease_expires_at = NULL,
         next_attempt_at = clock_timestamp() + make_interval(secs => p_retry_delay_seconds),
         last_error_code = p_error_code,
         ciphertext = CASE WHEN next_status = 'expired' THEN NULL ELSE ciphertext END,
         nonce = CASE WHEN next_status = 'expired' THEN NULL ELSE nonce END,
         auth_tag = CASE WHEN next_status = 'expired' THEN NULL ELSE auth_tag END
   WHERE inbox_id = p_inbox_id;
  RETURN next_status;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.purge_xero_webhook_inbox(
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'xero webhook purge limit is invalid' USING ERRCODE = '22023';
  END IF;
  -- Cryptographic expiry is independent from eventual metadata deletion.
  -- Scrub every terminal failure as well as unprocessed work once its bounded
  -- encrypted-retention window closes, even when no new webhook is claimable.
  WITH expired_candidates AS (
    SELECT item.inbox_id
      FROM control_plane.xero_webhook_inbox AS item
     WHERE item.expires_at <= clock_timestamp()
       AND item.status IN ('pending', 'processing', 'retry_wait', 'failed')
     ORDER BY item.expires_at, item.inbox_id
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE control_plane.xero_webhook_inbox AS item
     SET status = 'expired', lease_owner = NULL, lease_expires_at = NULL,
         ciphertext = NULL, nonce = NULL, auth_tag = NULL,
         last_error_code = 'inbox_retention_expired'
    FROM expired_candidates
   WHERE item.inbox_id = expired_candidates.inbox_id;
  WITH candidates AS (
    SELECT item.inbox_id
      FROM control_plane.xero_webhook_inbox AS item
     WHERE item.status IN ('processed', 'failed', 'expired')
       AND item.retain_until <= clock_timestamp()
     ORDER BY item.retain_until, item.inbox_id
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  ), deleted AS (
    DELETE FROM control_plane.xero_webhook_inbox AS item
     USING candidates
     WHERE item.inbox_id = candidates.inbox_id
    RETURNING 1
  )
  SELECT count(*)::integer INTO removed FROM deleted;
  RETURN removed;
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
    coalesce(array_agg(DISTINCT encryption_key_id ORDER BY encryption_key_id)
      FILTER (WHERE status IN ('pending', 'processing', 'retry_wait', 'failed')), ARRAY[]::text[])
  FROM control_plane.xero_webhook_inbox;
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_webhook_gateway_ready()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM control_plane.assert_pgmq_ready();
  PERFORM 1 FROM control_plane.xero_webhook_inbox_status_lookup LIMIT 1;
END;
$$;

-- The edge role never gets OAuth token/envelope access and cannot submit an
-- arbitrary sync payload. It can call only fixed webhook inbox/routing
-- procedures; the migration owner remains the only direct table owner.
REVOKE ALL ON TABLE
  control_plane.xero_webhook_inbox_status_lookup,
  control_plane.xero_webhook_inbox,
  control_plane.xero_webhook_sequence_disposition_lookup,
  control_plane.xero_webhook_sequence_state,
  control_plane.xero_webhook_sequence_observations,
  control_plane.xero_webhook_gap_status_lookup,
  control_plane.xero_webhook_gaps,
  control_plane.xero_webhook_connection_sequences,
  control_plane.xero_webhook_connection_deliveries,
  control_plane.xero_webhook_gap_recoveries
FROM PUBLIC, anon, authenticated, service_role, albert_webhook_control;

REVOKE SELECT ON TABLE
  control_plane.oauth_token_refs,
  control_plane.oauth_secret_envelopes,
  control_plane.oauth_session_secret_envelopes
FROM albert_webhook_control;
REVOKE EXECUTE ON FUNCTION control_plane.assert_pgmq_ready()
  FROM PUBLIC, albert_webhook_control;
REVOKE EXECUTE ON FUNCTION control_plane.enqueue_sync_job(jsonb, text, text, integer)
  FROM PUBLIC, albert_webhook_control;

REVOKE ALL ON FUNCTION control_plane.accept_xero_webhook_inbox(
  text, text, text, bytea, bytea, bytea, integer, integer, integer, integer,
  timestamptz, timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.claim_xero_webhook_inbox(text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.renew_xero_webhook_inbox_lease(text, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.record_xero_webhook_sequence(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.record_xero_webhook_connection_delivery(text, text, text, text[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.enqueue_xero_webhook_incremental(
  text, text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.enqueue_xero_webhook_gap_sweeps(text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.complete_xero_webhook_inbox(text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.fail_xero_webhook_inbox(
  text, text, text, integer, integer, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.purge_xero_webhook_inbox(integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.xero_webhook_inbox_health()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION control_plane.assert_webhook_gateway_ready()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION control_plane.accept_xero_webhook_inbox(
  text, text, text, bytea, bytea, bytea, integer, integer, integer, integer,
  timestamptz, timestamptz, timestamptz
) TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.claim_xero_webhook_inbox(text, integer, integer)
  TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.renew_xero_webhook_inbox_lease(text, text, integer)
  TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.record_xero_webhook_sequence(text, text)
  TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.record_xero_webhook_connection_delivery(text, text, text, text[])
  TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.enqueue_xero_webhook_incremental(
  text, text, text, text, text, timestamptz
) TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.enqueue_xero_webhook_gap_sweeps(text, timestamptz)
  TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.complete_xero_webhook_inbox(text, text, jsonb)
  TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.fail_xero_webhook_inbox(
  text, text, text, integer, integer, boolean
) TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.purge_xero_webhook_inbox(integer)
  TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.xero_webhook_inbox_health()
  TO albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.assert_webhook_gateway_ready()
  TO albert_webhook_control;

COMMIT;
