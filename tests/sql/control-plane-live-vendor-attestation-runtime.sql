\set ON_ERROR_STOP on

BEGIN;
SET LOCAL ROLE albert_vendor_connection_attestor;
SELECT control_plane.assert_live_vendor_attestation_boundary_ready() AS ready \gset
\if :ready
\else
  \echo 'independent vendor attestation runtime readiness failed'
  \quit 1
\endif
ROLLBACK;

SELECT 'control-plane live vendor attestation runtime passed' AS result;
