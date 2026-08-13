import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("Square deletion performs vendor revocation with generation-bound proof evidence", async () => {
  const [store, processor, config, controlMigration, runtimeContract] = await Promise.all([
    source("services/deletion-worker/src/store.ts"),
    source("services/deletion-worker/src/processor.ts"),
    source("services/deletion-worker/src/config.ts"),
    source("infra/migrations/control-plane/0126_m8_square_deletion_revocation_evidence.sql"),
    source("deploy/runtime-contract.json").then(JSON.parse),
  ]);

  assert.match(store, /connectorId: [^;]*"square"/u);
  assert.match(store, /connectorId !== "square"/u);
  assert.match(processor, /remoteProviders = new Set\(\[[^\]]*"square"/u);
  assert.match(processor, /target\.connectorId === "square"[\s\S]*new SquareConnector/u);
  assert.match(processor, /clientId: this\.config\.squareClientId/u);
  assert.match(processor, /clientSecret: this\.config\.squareClientSecret/u);
  assert.doesNotMatch(
    processor,
    /target\.connectorId === "square"[^\n]*\? "unsupported"/u,
  );
  assert.match(config, /required\(source, "SQUARE_CLIENT_ID"\)/u);
  assert.match(config, /required\(source, "SQUARE_CLIENT_SECRET"\)/u);
  assert.match(config, /\/api\/oauth\/square\/callback/u);

  assert.match(
    controlMigration,
    /NOT IN \([\s\S]*'lightspeed-r','lightspeed-x','xero','deputy','square'[\s\S]*\)/u,
  );
  assert.match(
    controlMigration,
    /Supersede the same[\s\S]*function OID[\s\S]*invalidate cached[\s\S]*plans immediately/u,
  );
  assert.match(
    controlMigration,
    /jsonb_object_keys\(p_remote\)\) NOT IN \(5,7\)[\s\S]*target_count<>jsonb_array_length/u,
  );
  const required = runtimeContract.runtimes["deletion-worker"].requiredSecretNames;
  for (const name of ["ALBERT_PUBLIC_ORIGIN", "SQUARE_CLIENT_ID", "SQUARE_CLIENT_SECRET"]) {
    assert.ok(required.includes(name), `deletion-worker must require ${name}`);
  }
});

test("Square source purge and residual verification remain behind one-use capabilities", async () => {
  const [capabilityMigration, squareMigration] = await Promise.all([
    source("infra/migrations/analytical/0083_m0_m8_signed_tenant_capability_enforcement.sql"),
    source("infra/migrations/analytical/0142_m8_square_deletion_coverage.sql"),
  ]);

  for (const operation of ["purge_connection", "purge_tenant", "verify_connection", "verify_tenant"]) {
    assert.match(
      capabilityMigration,
      new RegExp(
        `CREATE FUNCTION deletion_internal\\.${operation}\\([\\s\\S]*?activate_deletion_capability\\('deletion_(?:purge|verify)'\\)[\\s\\S]*?${operation}_pre_capability`,
        "u",
      ),
      `${operation} must consume its signed capability before entering the implementation`,
    );
  }
  assert.equal(
    (squareMigration.match(/activate_deletion_capability\('deletion_(?:purge|verify)'\)/gu) ?? []).length,
    4,
    "each recreated deletion entry point must consume exactly one capability",
  );
  for (const operation of ["purge_connection", "purge_tenant", "verify_connection", "verify_tenant"]) {
    assert.match(
      squareMigration,
      new RegExp(
        `CREATE OR REPLACE FUNCTION deletion_internal\\.${operation}\\([\\s\\S]*?activate_deletion_capability\\('deletion_(?:purge|verify)'\\)[\\s\\S]*?RETURN deletion_internal\\.${operation}_pre_capability`,
        "u",
      ),
    );
  }
  assert.match(
    squareMigration,
    /ALTER FUNCTION deletion_internal\.purge_connection_pre_capability\(text,text\)[\s\S]*RENAME TO purge_connection_before_square_source/u,
  );
  assert.match(squareMigration, /column_value\.table_schema='source_square'/u);
  assert.match(
    squareMigration,
    /DELETE FROM %I\.%I WHERE tenant_id=\$1 AND connection_id=\$2/u,
  );
  assert.match(
    squareMigration,
    /SELECT count\(\*\) FROM %I\.%I WHERE tenant_id=\$1 AND connection_id=\$2/u,
  );
  assert.match(
    squareMigration,
    /'stagingRows',staging/u,
    "Square residuals must be measured into the staging proof class",
  );
  assert.match(
    squareMigration,
    /REVOKE ALL ON FUNCTION[\s\S]*purge_connection_pre_capability\(text,text\)[\s\S]*FROM[\s\S]*deletion_rw/u,
  );
});
