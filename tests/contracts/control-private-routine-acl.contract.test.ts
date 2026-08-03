import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../infra/migrations/control-plane/0041_m0_default_deny_private_routines.sql",
  import.meta.url,
);

test("private control routines remain default-deny for public API roles", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(
    migration,
    /ALTER DEFAULT PRIVILEGES FOR ROLE albert_control_migration_owner[\s\S]*IN SCHEMA control_plane[\s\S]*REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role/iu,
  );
  assert.match(
    migration,
    /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC/iu,
  );
  assert.doesNotMatch(
    migration,
    /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA control_plane\s+FROM PUBLIC, anon, authenticated, service_role/iu,
  );
});
