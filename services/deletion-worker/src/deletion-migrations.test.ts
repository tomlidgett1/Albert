import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("deletion migrations contain durable queue fencing and all-store purge procedures", async () => {
  const [control, durableDisconnect, analytical, bootstrap, config, store, databaseRole] = await Promise.all([
    readFile(new URL("../../../infra/migrations/control-plane/0006_m8_deletion_lifecycle.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../infra/migrations/control-plane/0020_m8_durable_disconnect_intent.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../infra/migrations/analytical/0060_m8_deletion_procedures.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../infra/bootstrap/control_plane_role.sql", import.meta.url), "utf8"),
    readFile(new URL("./config.ts", import.meta.url), "utf8"),
    readFile(new URL("./store.ts", import.meta.url), "utf8"),
    readFile(new URL("./database-role.ts", import.meta.url), "utf8"),
  ]);
  for (const required of [
    "albert_deletion",
    "acquire_sync_write_permit",
    "assert_deletion_quiescent",
    "claim_deletion_jobs",
    "require_active_deletion_lease",
    "complete_deletion_job",
    "deletion_proofs",
    "albert_request_tenant_deletion",
    "albert_approve_tenant_deletion",
    "deletion_revocation_context",
    "read_deletion_credential",
    "rotate_deletion_credential",
    "destroy_one_deletion_credential",
    "verify_deletion_credentials",
    "destroy_claimed_deletion_credentials",
    "assert_claimed_deletion_quiescent",
    "verify_claimed_control_deletion",
  ]) assert.match(control, new RegExp(required));
  for (const required of [
    "deletion_internal.purge_connection",
    "deletion_internal.purge_tenant",
    "deletion_internal.verify_connection",
    "deletion_internal.verify_tenant",
    "canonical_record_state",
  ]) assert.match(analytical, new RegExp(required.replaceAll(".", "\\.")));
  assert.match(
    analytical,
    /DELETE FROM core\.order_source_observation[\s\S]*observation\.connection_id=p_connection_id/u,
  );
  assert.match(
    analytical,
    /DELETE FROM core\.order_line_source_observation[\s\S]*observation\.connection_id=p_connection_id/u,
  );
  assert.match(
    analytical,
    /DELETE FROM quality\.connector_check_observation[\s\S]*connection_id=p_connection_id/u,
  );
  assert.match(
    analytical,
    /verify_connection[\s\S]*core\.order_source_observation[\s\S]*core\.order_line_source_observation[\s\S]*quality\.connector_check_observation/u,
  );
  assert.match(control, /credential_destruction_due_at/);
  assert.match(control, /remote_revocation_grace_expired/);
  assert.match(durableDisconnect, /remote_revocation_status IN \([\s\S]*'pending'/);
  assert.match(
    durableDisconnect,
    /WHERE status IN \('queued', 'running', 'retry_wait', 'failed'\)[\s\S]*credential_destruction_due_at <= p_now/,
  );
  assert.doesNotMatch(durableDisconnect, /WHERE scope = 'tenant'/);
  assert.match(bootstrap, /CREATE ROLE albert_deletion_control[\s\S]*NOLOGIN/);
  assert.match(control, /TO albert_deletion_control/);
  assert.match(control, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC,anon,authenticated,service_role,albert_deletion_control/);
  assert.doesNotMatch(
    control,
    /GRANT (?:SELECT|ALL PRIVILEGES) ON TABLE[^;]*TO albert_deletion_control/,
  );
  assert.match(config, /DELETION_ANALYTICAL_DATABASE_URL/);
  assert.doesNotMatch(config, /required\(source, "ANALYTICAL_DATABASE_URL"\)/);
  assert.match(databaseRole, /set local role albert_deletion_control/);
  assert.match(store, /set local role deletion_rw/);
});
