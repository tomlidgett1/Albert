BEGIN;

-- One tenant-secured union over every Momence entity grain. The source table
-- policies remain authoritative because both views execute as the caller.
CREATE OR REPLACE VIEW source_momence.mo_source_records
WITH (security_barrier = true, security_invoker = true) AS
SELECT 'momence_profile'::text AS parent_stream, 'AuthProfile'::text AS source_object_type, t.*
  FROM source_momence.momence_profile t
UNION ALL
SELECT 'momence_members', 'Member', t.* FROM source_momence.momence_members t
UNION ALL
SELECT 'momence_memberships', 'Membership', t.* FROM source_momence.momence_memberships t
UNION ALL
SELECT 'momence_appointments', 'AppointmentReservation', t.* FROM source_momence.momence_appointments t
UNION ALL
SELECT 'momence_sessions', 'Session', t.* FROM source_momence.momence_sessions t
UNION ALL
SELECT 'momence_session_details', 'SessionDetail', t.* FROM source_momence.momence_session_details t
UNION ALL
SELECT 'momence_session_bookings', 'SessionBooking', t.* FROM source_momence.momence_session_bookings t
UNION ALL
SELECT 'momence_member_sessions', 'MemberSessionBooking', t.* FROM source_momence.momence_member_sessions t
UNION ALL
SELECT 'momence_member_appointments', 'MemberAppointmentReservation', t.* FROM source_momence.momence_member_appointments t
UNION ALL
SELECT 'momence_bought_memberships', 'BoughtMembership', t.* FROM source_momence.momence_bought_memberships t
UNION ALL
SELECT 'momence_member_notes', 'MemberNote', t.* FROM source_momence.momence_member_notes t
UNION ALL
SELECT 'momence_tags', 'Tag', t.* FROM source_momence.momence_tags t
UNION ALL
SELECT 'momence_public_locations', 'Location', t.* FROM source_momence.momence_public_locations t
UNION ALL
SELECT 'momence_public_memberships', 'PublicMembership', t.* FROM source_momence.momence_public_memberships t
UNION ALL
SELECT 'momence_public_sessions', 'PublicSession', t.* FROM source_momence.momence_public_sessions t
UNION ALL
SELECT 'momence_sales', 'Sale', t.* FROM source_momence.momence_sales t
UNION ALL
SELECT 'momence_payment_transactions', 'PaymentTransaction', t.* FROM source_momence.momence_payment_transactions t;

COMMENT ON VIEW source_momence.mo_source_records IS
  'All Momence entity records at their native grains. Never aggregate across parent_stream without a reviewed grain rule.';

CREATE OR REPLACE VIEW source_momence.mo_source_fields
WITH (security_barrier = true, security_invoker = true) AS
SELECT
  record.tenant_id,
  record.connection_id,
  record.external_account_reference,
  record.parent_stream,
  record.source_object_type,
  record.source_record_id,
  record.namespaced_source_key,
  record.namespaced_source_key || '#field:' || COALESCE(field.value ->> 'pointer', '') AS field_occurrence_key,
  field.value ->> 'path' AS field_path,
  field.value ->> 'pointer' AS field_pointer,
  COALESCE((field.value ->> 'ordinal')::integer, 0) AS field_ordinal,
  field.value ->> 'kind' AS value_kind,
  field.value ->> 'textValue' AS text_value,
  CASE
    WHEN field.value ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'
      THEN (field.value ->> 'numericValue')::numeric
    ELSE NULL
  END AS numeric_value,
  CASE
    WHEN field.value ->> 'booleanValue' = 'true' THEN true
    WHEN field.value ->> 'booleanValue' = 'false' THEN false
    ELSE NULL
  END AS boolean_value,
  CASE
    WHEN field.value ->> 'timestampValue' IS NOT NULL
      THEN (field.value ->> 'timestampValue')::timestamptz
    ELSE NULL
  END AS timestamp_value,
  field.value -> 'rawValue' AS raw_value,
  record.source_updated_at,
  record.ingested_at
FROM source_momence.mo_source_records record
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(record.field_index, '[]'::jsonb)) AS field(value)
WHERE NOT record.tombstone;

COMMENT ON VIEW source_momence.mo_source_fields IS
  'One row per scalar occurrence in every Momence entity, retaining stable path, exact pointer, ordinal and typed values.';

GRANT SELECT ON source_momence.mo_source_records,
                source_momence.mo_source_fields
  TO transform_rw, diagnostic_ro, semantic_ro;

COMMIT;
