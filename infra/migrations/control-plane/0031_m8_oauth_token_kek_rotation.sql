BEGIN;

-- Readiness and online KEK rotation inspect only active envelopes. These
-- partial indexes keep that proof bounded as retired credential revisions and
-- consumed OAuth sessions accumulate.
CREATE INDEX IF NOT EXISTS oauth_secret_envelopes_active_kek_idx
  ON control_plane.oauth_secret_envelopes
    (key_reference, key_version, tenant_id, token_ref_id)
  INCLUDE (oauth_secret_envelope_id, wrapped_data_key, credential_version)
  WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS oauth_session_secret_envelopes_active_kek_idx
  ON control_plane.oauth_session_secret_envelopes
    (key_reference, key_version, tenant_id, oauth_session_id)
  INCLUDE (oauth_session_secret_id, wrapped_data_key, credential_version, secret_kind)
  WHERE consumed_at IS NULL AND destroyed_at IS NULL;

COMMENT ON INDEX control_plane.oauth_secret_envelopes_active_kek_idx IS
  'Supports fail-closed active KEK coverage proof and SKIP LOCKED wrapped-DEK rotation without reading OAuth ciphertext.';

COMMENT ON INDEX control_plane.oauth_session_secret_envelopes_active_kek_idx IS
  'Supports fail-closed active OAuth-session KEK coverage proof and wrapped-DEK rotation.';

COMMIT;
