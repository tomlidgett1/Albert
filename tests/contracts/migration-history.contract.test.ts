import assert from "node:assert/strict";
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
