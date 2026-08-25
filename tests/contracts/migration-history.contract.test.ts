import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyticalMigrationBody,
  assertExactMigrationPrefix,
} from "../../scripts/migrate.js";

const local = [
  { id: "0001_first.sql", checksum: "a".repeat(64) },
  { id: "0002_second.sql", checksum: "b".repeat(64) },
  { id: "0003_third.sql", checksum: "c".repeat(64) },
] as const;

test("migration history accepts only an exact checksummed local prefix", () => {
  assert.doesNotThrow(() => assertExactMigrationPrefix(local, [
    { migration_id: "0001_first.sql", checksum_sha256: "a".repeat(64) },
    { migration_id: "0002_second.sql", checksum_sha256: "b".repeat(64) },
  ], "analytical"));
});

test("migration history rejects retrograde insertion, removal, gaps, and checksum drift", () => {
  const invalid = [
    [{ migration_id: "0002_second.sql", checksum_sha256: "b".repeat(64) }],
    [{ migration_id: "0001_removed.sql", checksum_sha256: "a".repeat(64) }],
    [
      { migration_id: "0001_first.sql", checksum_sha256: "a".repeat(64) },
      { migration_id: "0003_third.sql", checksum_sha256: "c".repeat(64) },
    ],
    [{ migration_id: "0001_first.sql", checksum_sha256: "f".repeat(64) }],
    [
      ...local.map(({ id, checksum }) => ({ migration_id: id, checksum_sha256: checksum })),
      { migration_id: "0004_missing.sql", checksum_sha256: "d".repeat(64) },
    ],
  ] as const;
  for (const history of invalid) {
    assert.throws(() => assertExactMigrationPrefix(local, history, "control-plane"));
  }
});

test("a fresh analytical bootstrap skips only the reviewed predecessor-pack data migration", () => {
  const migration = {
    id: "0129_m5_retire_renamed_predecessor_pack_surface.sql",
    checksum:
      "e7a2633e5e9df29982dd4ac2031a4f6774a60def7aad6a7a17ef21079723ae6c",
    body: "INSERT INTO historical_rows SELECT * FROM predecessor_rows;",
  };
  assert.match(analyticalMigrationBody(migration, true), /no predecessor pack rows/u);
  assert.equal(analyticalMigrationBody(migration, false), migration.body);
  assert.throws(
    () =>
      analyticalMigrationBody(
        { ...migration, checksum: "f".repeat(64) },
        true,
      ),
    /changed after its fresh-bootstrap data-migration review/u,
  );

  const capabilityCleanup = {
    id: "0131_m5_retire_capability_tombstones_after_activation.sql",
    checksum:
      "cf6a66b997095df92a0975fe94726106f269b84a733b2182ebe9e5cc33740fb7",
    body: "DELETE FROM historical_capability_tombstones;",
  };
  assert.match(
    analyticalMigrationBody(capabilityCleanup, true),
    /no predecessor pack rows/u,
  );
  assert.equal(
    analyticalMigrationBody(capabilityCleanup, false),
    capabilityCleanup.body,
  );
});

test("fresh analytical bootstrap supplies checksum-pinned retired Deputy compatibility", () => {
  const deputyViews = {
    id: "0134_m2_deputy_source_views.sql",
    checksum: "3c4b2ae020296affad452c187c3d9a4f3cee7802b3c6f3310a8f43488f073ae5",
    body: "CREATE VIEW source_deputy.dp_employees AS SELECT * FROM \"DEPUTYNEW\".deputy_employee;",
  };
  const executable = analyticalMigrationBody(deputyViews, true);
  assert.match(executable, /CREATE SCHEMA IF NOT EXISTS "DEPUTYNEW"/u);
  assert.match(executable, /deputy_employee/u);
  assert.match(executable, /CREATE VIEW source_deputy\.dp_employees/u);
  assert.equal(analyticalMigrationBody(deputyViews, false), deputyViews.body);

  const deputyRepoint = {
    id: "0169_m2_deputy_source_views_over_fivetran.sql",
    checksum: "003fa50c53fb5a54b7b66394a6362c99954c8b1ffa3bfbcf8576670fcb8db0a9",
    body: "SELECT ingestion.rebuild_fivetran_source_views('deputy');",
  };
  assert.match(analyticalMigrationBody(deputyRepoint, true), /no predecessor pack rows/u);
  assert.equal(analyticalMigrationBody(deputyRepoint, false), deputyRepoint.body);
});

test("fresh analytical bootstrap skips the retired XER_OFFICIAL source-view bridge", () => {
  for (const xeroViews of [
    {
      id: "0135_m2_xero_official_source_views.sql",
      checksum: "1daa4ccfdf4284c2593ad00827141449c83d67337b78a3bac27782ae733208a2",
    },
    {
      id: "0136_m2_xero_pnl_lines.sql",
      checksum: "a94a5a0ebb8059eb3512c1fb66de0b9c35479781b942ba370d3e0fbf5df081d1",
    },
    {
      id: "0137_m2_xero_gst_lines.sql",
      checksum: "471381fd878e1fab499dd5a0c81d5c8f0d6c0cf7218adc9384908ba34ae0deee",
    },
  ]) {
    const migration = {
      ...xeroViews,
      body: "CREATE VIEW source_xero_official.legacy AS SELECT * FROM \"XER_OFFICIAL\".legacy;",
    };
    assert.match(analyticalMigrationBody(migration, true), /no predecessor pack rows/u);
    assert.equal(analyticalMigrationBody(migration, false), migration.body);
    assert.throws(
      () => analyticalMigrationBody({ ...migration, checksum: "f".repeat(64) }, true),
      /changed after its fresh-bootstrap data-migration review/u,
    );
  }
});

test("fresh analytical bootstrap creates the current Xero official schema before repointing", () => {
  const repoint = {
    id: "0164_m2_xero_official_views_over_connector_staging.sql",
    checksum: "78f2c44ba04b366160e87e6b311ccfc6fba8f75e47ae213779bd323c6970f85b",
    body: "CREATE VIEW source_xero_official.xo_accounts AS SELECT * FROM source_xero.xero_accounts;",
  };
  assert.match(
    analyticalMigrationBody(repoint, true),
    /^CREATE SCHEMA IF NOT EXISTS source_xero_official;/u,
  );
  assert.equal(analyticalMigrationBody(repoint, false), repoint.body);
  assert.throws(
    () => analyticalMigrationBody({ ...repoint, checksum: "f".repeat(64) }, true),
    /fresh-bootstrap Xero schema compatibility review/u,
  );
});

test("fresh analytical bootstrap installs a credential-free Fivetran owner bridge", async () => {
  const runner = await readFile(new URL("../../scripts/migrate.ts", import.meta.url), "utf8");
  assert.match(runner, /ensureFreshAnalyticalFivetranOwner/u);
  assert.match(runner, /CREATE ROLE fivetran_user[\s\S]*NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION/u);
  assert.match(runner, /GRANT fivetran_user TO albert_migration_owner/u);
  assert.match(runner, /target\.stream !== "analytical"/u);
});

test("fresh analytical bootstrap installs Fivetran functions without an unbound Xero repoint", () => {
  const body = [
    "CREATE FUNCTION ingestion.rebuild_fivetran_source_views(text) RETURNS integer;",
    "SELECT ingestion.rebuild_fivetran_source_views('xero');",
    "RAISE EXCEPTION 'no active Fivetran Xero schema';",
    "DROP VIEW source_xero_official.xo_accounts;",
  ].join("\n");
  const migration = {
    id: "0168_m2_xero_official_views_over_fivetran.sql",
    checksum: "1ae4cb35ebab373890b688fbbd95543ae5dbf71cc012661fc93e92c60c083155",
    body,
  };
  const executable = analyticalMigrationBody(migration, true);
  assert.match(executable, /CREATE FUNCTION ingestion\.rebuild_fivetran_source_views/u);
  assert.match(executable, /SELECT ingestion\.rebuild_fivetran_source_views\('xero'\);$/u);
  assert.doesNotMatch(executable, /no active Fivetran Xero schema/u);
  assert.doesNotMatch(executable, /DROP VIEW source_xero_official/u);
  assert.equal(analyticalMigrationBody(migration, false), body);
  assert.throws(
    () => analyticalMigrationBody({ ...migration, checksum: "f".repeat(64) }, true),
    /fresh-bootstrap Fivetran repoint review/u,
  );
});
