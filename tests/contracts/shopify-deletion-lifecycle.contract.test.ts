import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("Shopify disconnect destroys only Albert credentials and emits honest revocation evidence", async () => {
  const [store, processor, config, proofMigration] = await Promise.all([
    source("services/deletion-worker/src/store.ts"),
    source("services/deletion-worker/src/processor.ts"),
    source("services/deletion-worker/src/config.ts"),
    source("infra/migrations/control-plane/0129_m8_shopify_deletion_revocation_evidence.sql"),
  ]);

  assert.match(store, /connectorId:[\s\S]{0,240}\| "shopify"/u);
  assert.match(store, /connectorId !== "shopify"/u);
  assert.match(processor, /remoteProviders = new Set\([\s\S]*"momence",[\s\S]*"shopify"/u);
  assert.match(
    processor,
    /target\.connectorId === "shopify"[\s\S]{0,600}await vault\.destroy\(target\.credentialRef\)/u,
  );
  assert.match(
    processor,
    /target\.connectorId === "shopify"[\s\S]{0,180}\? "unsupported"/u,
  );
  assert.doesNotMatch(processor, /new ShopifyConnector/u);
  assert.doesNotMatch(processor, /mutation\s+appUninstall/u);
  assert.doesNotMatch(config, /required\(source, "SHOPIFY_(?:CLIENT_ID|CLIENT_SECRET)"\)/u);

  assert.match(
    proofMigration,
    /'lightspeed-r','lightspeed-x','xero','deputy','square','momence','shopify'/u,
  );
  assert.match(
    proofMigration,
    /target->>'status' NOT IN \('succeeded','unsupported','failed'\)/u,
  );
  assert.match(
    proofMigration,
    /target->>'provider'='shopify'[\s\S]*target->>'status'='succeeded'/u,
    "the database must reject a false claim of successful remote Shopify revocation",
  );
  assert.match(proofMigration, /2026-07\/mutations\/appUninstall/u);
  assert.match(proofMigration, /offline-access-tokens/u);
  assert.match(proofMigration, /session-tokens\/set-up-session-tokens/u);
  assert.match(proofMigration, /compliance\/privacy-law-compliance/u);
  for (const topic of [
    "app/uninstalled",
    "customers/data_request",
    "customers/redact",
    "shop/redact",
  ]) {
    assert.match(proofMigration, new RegExp(topic.replace("/", "\\/"), "u"));
  }
  assert.match(proofMigration, /receipt is never evidence[\s\S]*purge completed/u);
  assert.match(proofMigration, /COMMENT ON FUNCTION[\s\S]*inbound lifecycle triggers, never purge-completion evidence/u);
  assert.match(
    proofMigration,
    /REVOKE ALL ON FUNCTION[\s\S]*require_privacy_safe_remote_revocation[\s\S]*FROM PUBLIC,anon,authenticated,service_role/u,
  );
});

test("Shopify source purge composes below one-use capabilities and covers every staging base table", async () => {
  const [stagingMigration, deletionMigration] = await Promise.all([
    source("infra/migrations/analytical/0138_m2_shopify_full_staging.sql"),
    source("infra/migrations/analytical/0152_m8_shopify_deletion_closure.sql"),
  ]);

  const tableCount = (stagingMigration.match(
    /CREATE TABLE IF NOT EXISTS "source_shopify"\."shopify_[^"]+"/gu,
  ) ?? []).length;
  assert.equal(tableCount, 16, "the typed Shopify staging contract currently contains 16 base tables");
  assert.equal(
    (stagingMigration.match(/^  tenant_id text NOT NULL,/gmu) ?? []).length,
    tableCount,
    "every Shopify staging table must be tenant-addressable",
  );
  assert.equal(
    (stagingMigration.match(/^  connection_id text NOT NULL/gmu) ?? []).length,
    tableCount,
    "every Shopify staging table must be connection-addressable",
  );

  assert.match(
    deletionMigration,
    /ALTER FUNCTION deletion_internal\.purge_connection_pre_capability\(text,text\)[\s\S]*RENAME TO purge_connection_before_shopify_staging/u,
  );
  assert.match(
    deletionMigration,
    /information_schema\.tables[\s\S]*information_schema\.columns[\s\S]*table_schema='source_shopify'[\s\S]*table_type='BASE TABLE'/u,
  );
  assert.match(
    deletionMigration,
    /DELETE FROM source_shopify\.%I[\s\S]*tenant_id=\$1 AND connection_id=\$2/u,
  );
  assert.match(deletionMigration, /DELETE FROM source_shopify\.%I WHERE tenant_id=\$1/u);
  assert.match(deletionMigration, /source_shopify table % lacks tenant_id or connection_id/u);
  assert.match(deletionMigration, /EXCEPTION WHEN foreign_key_violation THEN[\s\S]*NULL/u);
  assert.match(deletionMigration, /Shopify connection purge left % staging rows/u);
  assert.match(deletionMigration, /Shopify tenant purge left % staging rows/u);
  assert.equal(
    (deletionMigration.match(/jsonb_object_keys\(base->'residuals'\)\)<>7/gu) ?? []).length,
    2,
  );
  assert.equal(
    (deletionMigration.match(/base,\s*'\{residuals,stagingRows\}'/gu) ?? []).length,
    2,
  );
  assert.equal(
    (deletionMigration.match(/activate_deletion_capability\('deletion_(?:purge|verify)'\)/gu) ?? []).length,
    4,
    "each stable public entry point must consume exactly one signed capability",
  );
  assert.equal(
    (deletionMigration.match(/evidence->>'request_scope' IS DISTINCT FROM '(?:connection|tenant)'/gu) ?? []).length,
    4,
    "all wrappers must bind the signed operation to its exact scope",
  );
  assert.equal(
    (deletionMigration.match(/evidence->'connection_id' IS DISTINCT FROM 'null'::jsonb/gu) ?? []).length,
    2,
    "tenant capabilities must bind an explicit null connection target",
  );
  assert.match(
    deletionMigration,
    /REVOKE ALL ON FUNCTION[\s\S]*purge_connection_pre_capability\(text,text\)[\s\S]*FROM[\s\S]*deletion_rw/u,
  );
  assert.match(
    deletionMigration,
    /GRANT EXECUTE ON FUNCTION[\s\S]*deletion_internal\.purge_connection\(text,text\)[\s\S]*deletion_internal\.verify_tenant\(text\)[\s\S]*TO deletion_rw/u,
  );
});
