import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("Momence deletion accepts the target, destroys the local grant, and records unsupported remote revocation", async () => {
  const [store, processor, squareProofMigration, proofMigration, shopifyProofMigration] = await Promise.all([
    source("services/deletion-worker/src/store.ts"),
    source("services/deletion-worker/src/processor.ts"),
    source("infra/migrations/control-plane/0126_m8_square_deletion_revocation_evidence.sql"),
    source("infra/migrations/control-plane/0127_m8_momence_deletion_revocation_evidence.sql"),
    source("infra/migrations/control-plane/0129_m8_shopify_deletion_revocation_evidence.sql"),
  ]);

  assert.match(store, /connectorId: [^;]*"momence"/u);
  assert.match(store, /connectorId !== "momence"/u);
  assert.match(processor, /remoteProviders = new Set\([\s\S]*"square",[\s\S]*"momence"/u);
  assert.match(
    processor,
    /target\.connectorId === "momence"[\s\S]{0,320}await vault\.destroy\(target\.credentialRef\)/u,
  );
  assert.match(
    processor,
    /target\.connectorId === "momence"[\s\S]{0,180}\? "unsupported"/u,
  );
  assert.doesNotMatch(processor, /new MomenceConnector/u);

  assert.match(
    proofMigration,
    /'lightspeed-r','lightspeed-x','xero','deputy','square','momence'/u,
  );
  assert.match(
    proofMigration,
    /target->>'status' NOT IN \('succeeded','unsupported','failed'\)/u,
  );
  assert.match(
    proofMigration,
    /REVOKE ALL ON FUNCTION[\s\S]*require_privacy_safe_remote_revocation[\s\S]*FROM PUBLIC,anon,authenticated,service_role/u,
  );
  for (const migration of [squareProofMigration, proofMigration, shopifyProofMigration]) {
    assert.match(
      migration,
      /GRANT EXECUTE ON FUNCTION[\s\S]*require_privacy_safe_remote_revocation\(jsonb\)[\s\S]*TO albert_control_migration_owner/u,
      "control-plane deletion validators must grant only to the control migration role",
    );
    assert.doesNotMatch(
      migration,
      /TO albert_migration_owner/u,
      "the analytical migration role does not exist in the control-plane database",
    );
  }
});

test("Momence source purge composes below one-use capabilities and measures every staging base table", async () => {
  const [stagingMigration, deletionMigration] = await Promise.all([
    source("infra/migrations/analytical/0139_m3_momence_full_staging.sql"),
    source("infra/migrations/analytical/0149_m8_momence_deletion_closure.sql"),
  ]);

  assert.match(
    deletionMigration,
    /ALTER FUNCTION deletion_internal\.purge_connection_pre_capability\(text,text\)[\s\S]*RENAME TO purge_connection_before_momence_staging/u,
  );
  assert.match(
    deletionMigration,
    /information_schema\.tables[\s\S]*information_schema\.columns[\s\S]*table_schema='source_momence'[\s\S]*table_type='BASE TABLE'/u,
  );
  assert.match(
    deletionMigration,
    /DELETE FROM source_momence\.%I[\s\S]*tenant_id=\$1 AND connection_id=\$2/u,
  );
  assert.match(
    deletionMigration,
    /DELETE FROM source_momence\.%I WHERE tenant_id=\$1/u,
  );
  assert.match(deletionMigration, /EXCEPTION WHEN foreign_key_violation THEN[\s\S]*NULL/u);
  assert.match(deletionMigration, /Momence connection purge left % staging rows/u);
  assert.match(deletionMigration, /Momence tenant purge left % staging rows/u);
  assert.equal(
    (deletionMigration.match(/jsonb_object_keys\(base->'residuals'\)\)<>7/gu) ?? []).length,
    2,
  );
  assert.equal(
    (deletionMigration.match(/base,\s*'\{residuals,stagingRows\}'/gu) ?? []).length,
    2,
  );
  assert.match(
    deletionMigration,
    /REVOKE ALL ON FUNCTION[\s\S]*purge_connection_pre_capability\(text,text\)[\s\S]*FROM[\s\S]*deletion_rw/u,
  );
  assert.match(
    deletionMigration,
    /GRANT EXECUTE ON FUNCTION[\s\S]*purge_connection_pre_capability\(text,text\)[\s\S]*TO albert_migration_owner/u,
  );
  assert.equal(
    (deletionMigration.match(/activate_deletion_capability\('deletion_(?:purge|verify)'\)/gu) ?? []).length,
    4,
    "each stable public entry point must consume exactly one signed capability",
  );
  assert.equal(
    (deletionMigration.match(/evidence->>'request_scope' IS DISTINCT FROM '(?:connection|tenant)'/gu) ?? []).length,
    4,
    "missing or mismatched signed scope evidence must fail closed",
  );
  assert.equal(
    (deletionMigration.match(/evidence->'connection_id' IS DISTINCT FROM 'null'::jsonb/gu) ?? []).length,
    2,
    "tenant capabilities must require an explicit null connection target",
  );
  assert.match(
    deletionMigration,
    /GRANT EXECUTE ON FUNCTION[\s\S]*deletion_internal\.purge_connection\(text,text\)[\s\S]*deletion_internal\.verify_tenant\(text\)[\s\S]*TO deletion_rw/u,
  );

  assert.doesNotMatch(
    stagingMigration,
    /GRANT [^;]+ ON ALL TABLES IN SCHEMA "source_(?:square|lightspeed_x|shopify)"/u,
    "Momence staging must not reference connector schemas created by later migrations",
  );
});
