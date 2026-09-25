import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("CI executes a real isolated Momence 0152 to 0153 database upgrade", async () => {
  const [runner, seed, assertions, workflow] = await Promise.all([
    readFile(new URL("scripts/test-momence-0153-upgrade.mts", root), "utf8"),
    readFile(
      new URL("tests/sql/analytical-momence-0153-upgrade-seed.sql", root),
      "utf8",
    ),
    readFile(
      new URL("tests/sql/analytical-momence-0153-upgrade-assert.sql", root),
      "utf8",
    ),
    readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
  ]);

  assert.match(runner, /const FIXTURE_DATABASE = "albert_momence_0153_upgrade_ci"/u);
  assert.match(runner, /const PREFIX_END = "0152_m8_shopify_deletion_closure\.sql"/u);
  assert.match(
    runner,
    /const TRANSITION = "0153_m2_momence_bounded_reconciliation_transition\.sql"/u,
  );
  assert.match(runner, /analyticalMigrationBody\(migration, true\)/u);
  assert.match(runner, /SET ROLE albert_migration_owner/u);
  assert.match(runner, /transition\.body/u);
  assert.match(
    runner,
    /finally \{[\s\S]+DROP DATABASE IF EXISTS[\s\S]+WITH \(FORCE\)/u,
    "the isolated database must be removed after both successful and failed proofs",
  );

  assert.match(
    seed,
    /canonical_staging_batch_records[\s\S]+source_momence\.momence_sessions[\s\S]+authoritative_identity_scan[\s\S]+reconciliation_tombstone_application/u,
    "the pre-0153 seed must contain immutable lineage and the mutable damage caused by the old policy",
  );
  assert.match(
    seed,
    /canonical_transform_commits[\s\S]+core\.worker[\s\S]+core\.location[\s\S]+canonical_record_state[\s\S]+entity_source_link/u,
    "the pre-0153 seed must prove recovery after the invalid tombstone reached canonical state",
  );
  assert.match(
    seed,
    /Session 502 is the adversarial history[\s\S]+2026-08-02T11:00:00Z[\s\S]+2026-07-15T08:00:00Z[\s\S]+01H00000000000000000000Q0Q/u,
    "the seed must include a later live transform whose vendor timestamp cannot normally beat the synthetic tombstone",
  );
  assert.match(
    seed,
    /A' is an identical replay of A[\s\S]+01H00000000000000000000Q0T[\s\S]+'5',false[\s\S]+2026-06-15T08:00:00Z','2026-07-20T08:00:00Z/u,
    "the seed must retain an identical replay with a misleadingly higher timestamp",
  );
  assert.match(
    seed,
    /01H00000000000000000000Q0T'[\s\S]+momence_sessions','momence-v1',1,0,3,0,1/u,
    "the identical replay must record that it produced no canonical rows",
  );
  assert.match(
    assertions,
    /landing current state must exactly match[\s\S]+every mutable typed field must exactly match/u,
  );
  assert.match(
    assertions,
    /rolbypassrls[\s\S]+relforcerowsecurity[\s\S]+migration owner read landing rows without tenant context/u,
  );
  assert.match(
    assertions,
    /stale Momence tombstone landing write was accepted[\s\S]+superseded Momence stream policy was accepted/u,
  );
  assert.match(
    assertions,
    /worker dimension must be restored[\s\S]+location dimension must be restored[\s\S]+no canonical state may retain the invalid bounded tombstone lineage/u,
  );
  assert.match(
    assertions,
    /later live landing with an older vendor timestamp must remain current[\s\S]+best transformed live observation despite its older vendor timestamp/u,
  );
  assert.match(
    assertions,
    /identical no-op replay even though its timestamp exceeds B[\s\S]+A-prime must remain immutable audit evidence and never become canonical lineage/u,
  );
  assert.match(
    workflow,
    /name: Prove the Momence 0152 to 0153 production upgrade path[\s\S]+npx tsx scripts\/test-momence-0153-upgrade\.mts/u,
  );
});
