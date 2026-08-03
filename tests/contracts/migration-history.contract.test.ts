import assert from "node:assert/strict";
import test from "node:test";

import { assertExactMigrationPrefix } from "../../scripts/migrate.js";

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
