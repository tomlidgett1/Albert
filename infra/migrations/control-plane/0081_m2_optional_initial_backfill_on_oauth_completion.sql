-- A connector pack may be authorised before its ingestion is cleared for
-- production (ALBERT_OAUTH_SUPPRESS_INITIAL_BACKFILL on the sync worker). Such
-- a connect stores its rotating credential and creates an active connection,
-- but deliberately enqueues no InitialBackfill, so completion_result carries a
-- null jobRequestId.
--
-- Both completion-result constraints previously required jobRequestId to be a
-- ULID unconditionally, which would abort the finalize transaction and fail the
-- whole OAuth connect. Relax them to accept a null jobRequestId exactly when
-- the row records initialBackfillSuppressed = true, so an incomplete write is
-- still rejected: a missing job identity remains a violation unless suppression
-- was the deliberate, recorded reason.

BEGIN;

ALTER TABLE control_plane.oauth_sessions
  DROP CONSTRAINT IF EXISTS oauth_sessions_completion_result_check;
ALTER TABLE control_plane.oauth_sessions
  ADD CONSTRAINT oauth_sessions_completion_result_check CHECK (
    completion_result IS NULL
    OR (
      status='consumed'
      AND jsonb_typeof(completion_result)='object'
      AND coalesce(control_plane.is_ulid(completion_result->>'connectionId'),false)
      AND CASE
        WHEN coalesce((completion_result->>'initialBackfillSuppressed')::boolean,false)
          THEN jsonb_typeof(completion_result->'jobRequestId')='null'
        ELSE coalesce(control_plane.is_ulid(completion_result->>'jobRequestId'),false)
      END
    )
  );

-- Retains NOT VALID so historical replay records stay readable while every new
-- write is held to the stronger generation-bound contract.
ALTER TABLE control_plane.oauth_sessions
  DROP CONSTRAINT IF EXISTS oauth_sessions_completion_generation_binding_check;
ALTER TABLE control_plane.oauth_sessions
  ADD CONSTRAINT oauth_sessions_completion_generation_binding_check CHECK (
    completion_result IS NULL OR (
      completion_result ?& ARRAY[
        'connectionId','jobRequestId','oauthSessionId','connectionGeneration'
      ]
      AND completion_result->>'oauthSessionId'=oauth_session_id
      AND coalesce(control_plane.is_ulid(completion_result->>'connectionId'),false)
      AND CASE
        WHEN coalesce((completion_result->>'initialBackfillSuppressed')::boolean,false)
          THEN jsonb_typeof(completion_result->'jobRequestId')='null'
        ELSE coalesce(control_plane.is_ulid(completion_result->>'jobRequestId'),false)
      END
      AND (completion_result->>'connectionGeneration')~'^[1-9][0-9]*$'
    )
  ) NOT VALID;

COMMENT ON COLUMN control_plane.oauth_sessions.completion_result IS
  'Non-secret terminal connection and initial-job identifiers used to replay a committed OAuth callback after response loss. jobRequestId is null only when initialBackfillSuppressed is true, meaning the connector was authorised without starting ingestion.';

COMMIT;
