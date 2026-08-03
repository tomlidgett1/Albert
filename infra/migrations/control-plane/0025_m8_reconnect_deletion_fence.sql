BEGIN;

-- Re-authorisation may supersede a connection-level deletion only while no
-- deletion worker owns the request.  The original M8 approval constraint
-- accidentally made that lawful cancellation impossible for connection
-- requests, even though the OAuth finaliser already attempted it.  Tenant
-- cancellation remains restricted to the pre-approval window.
ALTER TABLE control_plane.deletion_requests
  DROP CONSTRAINT IF EXISTS deletion_requests_approval_state_check;

ALTER TABLE control_plane.deletion_requests
  ADD CONSTRAINT deletion_requests_approval_state_check CHECK (
    (
      status = 'awaiting_approval'
      AND scope = 'tenant'
      AND approved_at IS NULL
      AND approved_by IS NULL
      AND credential_destroyed_at IS NULL
      AND approval_expires_at IS NOT NULL
    ) OR (
      status = 'cancelled'
      AND (
        scope = 'connection'
        OR (
          scope = 'tenant'
          AND approved_at IS NULL
          AND approved_by IS NULL
          AND credential_destroyed_at IS NULL
          AND approval_expires_at IS NOT NULL
        )
      )
    ) OR (
      status NOT IN ('awaiting_approval', 'cancelled')
      AND (
        scope = 'connection'
        OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
      )
    )
  );

COMMIT;
