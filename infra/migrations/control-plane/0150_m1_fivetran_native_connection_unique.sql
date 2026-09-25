-- 0150: one live Fivetran connection per native grant.
--
-- The Deputy double-fire (2026-08-17) raced two /v1/fivetran/deputy/start
-- calls past the read-side dedupe: the fivetran_connections row is inserted
-- only after Fivetran's slow create+setup-test, so both requests passed
-- findByNativeConnection before either committed and two identical
-- connections (and destination schemas) were created. This partial unique
-- index makes the loser's insert fail atomically; the worker catches the
-- unique violation, deletes its just-created Fivetran connection, and
-- returns the surviving row instead.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS fivetran_connections_native_live_unique ON control_plane.fivetran_connections (tenant_id, (account_metadata ->> 'nativeConnectionId')) WHERE status IN ('connected', 'degraded', 'blocked') AND account_metadata ? 'nativeConnectionId';

COMMIT;
