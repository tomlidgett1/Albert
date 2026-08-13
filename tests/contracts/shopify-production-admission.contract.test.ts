import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { shopifyManifest } from "../../connectors/shopify/manifest.js";
import { SHOPIFY_STREAM_FIELDS } from "../../connectors/shopify/streams.js";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("Shopify is admitted atomically through every durable analytical runtime boundary", async () => {
  const migration = await source(
    "infra/migrations/analytical/0154_m3_shopify_production_admission.sql",
  );

  for (const relation of [
    "quality.connector_check_observation",
    "quality.connector_stream_state",
    "quality.reconciliation_snapshot",
    "ingestion.canonical_staging_batch_records",
    "semantic_internal.canonical_transform_commits",
    "semantic_internal.connector_pack_release",
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE ${relation.replaceAll(".", "\\.")}`, "u"));
  }
  assert.equal(
    (migration.match(
      /CHECK \(connector_id IN \('lightspeed-r','xero','deputy','momence','square','shopify'\)\)/gu,
    ) ?? []).length,
    6,
  );
  assert.match(migration, /'shopify','1\.0\.0',1,NULL,'active'/u);
  assert.match(migration, /0154_m3_shopify_production_admission\.sql/u);
  assert.match(migration, /release\.registered_by_migration='0154_m3_shopify_production_admission\.sql'/u);

  for (const runtimeFunction of [
    "register_connector_streams",
    "record_reconciliation_snapshot_page",
    "publish_connector_quality_results",
    "publish_connector_capability_observations",
  ]) {
    assert.match(migration, new RegExp(`'${runtimeFunction}'`, "u"));
  }
  assert.match(migration, /CREATE TEMP TABLE _shopify_admission_relation_security_guard/u);
  assert.match(migration, /CREATE TEMP TABLE _shopify_admission_function_security_guard/u);
  assert.match(migration, /current_value\.relacl IS DISTINCT FROM guarded\.relacl/u);
  assert.match(migration, /current_value\.proacl IS DISTINCT FROM guarded\.proacl/u);
  assert.match(migration, /current_value\.prosecdef IS DISTINCT FROM guarded\.prosecdef/u);
  assert.match(migration, /current_value\.proconfig IS DISTINCT FROM guarded\.proconfig/u);
  assert.match(migration, /'anon','authenticated','service_role'/u);
  assert.match(migration, /USING ERRCODE='42501'/u);
  assert.doesNotMatch(migration, /GRANT\s+/u);
  assert.doesNotMatch(migration, /DISABLE ROW LEVEL SECURITY/u);
});

test("the admitted pack, typed staging, and production canonical mapper share one 16-stream identity", async () => {
  const [stagingMigration, transformMain] = await Promise.all([
    source("infra/migrations/analytical/0138_m2_shopify_full_staging.sql"),
    source("services/transform-worker/src/main.ts"),
  ]);
  const manifestStreams = shopifyManifest.streams.map(({ id }) => id).sort();
  const typedStreams = Object.keys(SHOPIFY_STREAM_FIELDS).sort();
  const stagedStreams = [...stagingMigration.matchAll(
    /CREATE TABLE IF NOT EXISTS "source_shopify"\."(shopify_[^"]+)"/gu,
  )].map((match) => match[1]).sort();

  assert.equal(shopifyManifest.id, "shopify");
  assert.equal(shopifyManifest.packVersion, "1.0.0");
  assert.equal(manifestStreams.length, 16);
  assert.deepEqual(typedStreams, manifestStreams);
  assert.deepEqual(stagedStreams, manifestStreams);
  assert.match(transformMain, /import \{ mapShopifyCanonical \} from "\.\.\/\.\.\/\.\.\/connectors\/shopify\/canonical\.js"/u);
  assert.match(transformMain, /"shopify": mapShopifyCanonical/u);
});
