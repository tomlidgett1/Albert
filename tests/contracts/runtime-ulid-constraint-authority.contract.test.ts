import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  "infra/migrations/control-plane/0068_m8_runtime_ulid_constraint_authority.sql",
  "utf8",
);

test("runtime roles can satisfy ULID checks without broader private-routine authority", () => {
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION control_plane\.is_ulid\(text\) FROM PUBLIC/u,
  );
  for (const role of [
    "albert_sync_control",
    "albert_webhook_control",
    "albert_transform_control",
    "albert_semantic_control",
    "albert_operator_diagnostic_control",
    "albert_deletion_control",
    "albert_vendor_connection_attestor",
  ]) {
    assert.match(migration, new RegExp(`\\b${role}\\b`, "u"));
  }
  assert.doesNotMatch(migration, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL)/iu);
});
