-- 0129's capability tombstones existed for exactly one moment: to prove to
-- the activation gate that the predecessor's renamed capability surface was
-- deliberately retired. Activation consumed that proof — and then made the
-- tombstones part of the ACTIVE capability surface, where an
-- available=false row marks the whole connection ineligible as an
-- authoritative source. The dogfood agent refused sales questions minutes
-- after activation. Field tombstones are inactive rows and stay; capability
-- rows have no active flag, so retirement is deletion.

BEGIN;

DELETE FROM semantic_internal.connector_pack_tenant_capability_snapshot
 WHERE connector_id='lightspeed-r' AND pack_version='2.0.0'
   AND reason_code='pack_renamed_source_namespace';

DELETE FROM semantic_internal.tenant_capability
 WHERE connector_id='lightspeed-r'
   AND reason_code='pack_renamed_source_namespace';

COMMIT;
