BEGIN;

-- The web and credential-owning worker already permit plaintext OAuth only for
-- loopback development origins. Keep the database constraint aligned with that
-- exact boundary; the worker additionally allow-lists the single configured
-- callback, while production configuration rejects every non-HTTPS origin.
ALTER TABLE control_plane.oauth_sessions
  DROP CONSTRAINT oauth_sessions_redirect_uri_check;
ALTER TABLE control_plane.oauth_sessions
  ADD CONSTRAINT oauth_sessions_redirect_uri_check CHECK (
    redirect_uri ~ '^https://'
    OR redirect_uri ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]{1,5})?/'
  );

COMMIT;
