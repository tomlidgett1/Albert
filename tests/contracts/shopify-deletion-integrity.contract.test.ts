import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { extractShopifyPage } from "../../connectors/shopify/extract.js";
import { shopifyManifest } from "../../connectors/shopify/manifest.js";
import { ConnectorError } from "../../packages/connector-sdk/src/index.js";
import {
  shopifyDeletionContinuityBlockReason,
  shopifyInitialDeletionCursor,
} from "../../services/sync-workers/src/worker.js";

const FROM = "2026-08-10T00:00:00.000Z";
const TO = "2026-08-12T00:00:00.000Z";
const RESOURCE_WATERMARK = "2026-08-11T18:00:00.000Z";

function deletionCursor(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    value: JSON.stringify({
      version: 1,
      deletionEventPhase: true,
      deletionEventAfter: null,
      deletionEventFrom: FROM,
      deletionEventTo: TO,
      deletionEventWatermark: FROM,
      resourceWatermark: RESOURCE_WATERMARK,
      ...overrides,
    }),
    sourceUpdatedAt: "2026-08-01T00:00:00.000Z",
  };
}

test("destroy events tombstone every officially supported Shopify parent grain", async () => {
  const cases = [
    ["shopify_products", "PRODUCT", "Product"],
    ["shopify_product_variants", "PRODUCT_VARIANT", "ProductVariant"],
    ["shopify_customers", "CUSTOMER", "Customer"],
    ["shopify_orders", "ORDER", "Order"],
    ["shopify_discounts", "DISCOUNT_NODE", "DiscountNode"],
  ] as const;

  for (const [stream, subjectType, sourceObjectType] of cases) {
    let variables: Readonly<Record<string, unknown>> | undefined;
    const page = await extractShopifyPage({
      stream,
      mode: "incremental",
      cursor: deletionCursor(),
      now: () => Date.parse(TO),
      readAllOrders: true,
      call: async (query, supplied) => {
        assert.match(query, /events\(first:\$first,after:\$after,sortKey:CREATED_AT,query:\$query\)/u);
        variables = supplied;
        return {
          errors: [],
          data: {
            events: {
              edges: [{
                cursor: "event-1",
                node: {
                  __typename: "BasicEvent",
                  id: `gid://shopify/BasicEvent/${subjectType}`,
                  action: "destroy",
                  createdAt: "2026-08-11T12:00:00.000Z",
                  subjectId: `gid://shopify/${sourceObjectType}/42`,
                  subjectType,
                },
              }],
              pageInfo: { hasNextPage: false, endCursor: "event-1" },
            },
          },
        };
      },
    });
    assert.equal(variables?.first, 100);
    assert.equal(variables?.after, null);
    assert.equal(
      variables?.query,
      `action:destroy comments:false subject_type:${subjectType} created_at:>='${FROM}' created_at:<='${TO}'`,
    );
    assert.equal(page.records.length, 1);
    assert.equal(page.records[0]?.sourceObjectType, sourceObjectType);
    assert.equal(page.records[0]?.sourceRecordId, `gid://shopify/${sourceObjectType}/42`);
    assert.equal(page.records[0]?.normalized?.tombstone, true);
    assert.equal(page.records[0]?.deletionSignal?.kind, "verified_vendor_delete_feed");
    assert.equal(page.nextCursor?.sourceUpdatedAt, RESOURCE_WATERMARK);
    assert.deepEqual(JSON.parse(page.nextCursor!.value), {
      version: 1,
      deletionEventWatermark: TO,
    });
  }
});

test("empty event pages commit only the frozen resource watermark and invalid events fail closed", async () => {
  const empty = await extractShopifyPage({
    stream: "shopify_products",
    mode: "incremental",
    cursor: deletionCursor(),
    now: () => Date.parse("2026-08-12T23:59:59.000Z"),
    readAllOrders: true,
    call: async () => ({
      errors: [],
      data: { events: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    }),
  });
  assert.equal(empty.records.length, 0);
  assert.equal(empty.nextCursor?.sourceUpdatedAt, RESOURCE_WATERMARK);
  assert.equal(JSON.parse(empty.nextCursor!.value).deletionEventWatermark, TO);

  await assert.rejects(
    extractShopifyPage({
      stream: "shopify_products",
      mode: "incremental",
      cursor: deletionCursor(),
      now: () => Date.parse(TO),
      readAllOrders: true,
      call: async () => ({
        errors: [],
        data: { events: {
          edges: [{ cursor: "bad", node: {
            __typename: "BasicEvent",id: "event",action: "destroy",
            createdAt: "2026-08-09T23:59:59.999Z",
            subjectId: "gid://shopify/Product/1",subjectType: "PRODUCT",
          } }],
          pageInfo: { hasNextPage: false, endCursor: "bad" },
        } },
      }),
    }),
    (error: unknown) => error instanceof ConnectorError &&
      error.code === "REMOTE_RESPONSE_INVALID" &&
      error.details?.reason === "shopify_deletion_feed_unavailable",
  );
});

test("one-year retention gaps and legacy cursors are explicitly unavailable", async () => {
  let resourceCalls = 0;
  const emptyProducts = async () => {
    resourceCalls += 1;
    return {
      errors: [],data: { products: { edges: [],pageInfo: { hasNextPage: false,endCursor: null } } },
    };
  };
  for (const [cursorValue, reason] of [
    [{ version: 1 }, "shopify_deletion_watermark_missing"],
    [{ version: 1, deletionEventWatermark: "2025-01-01T00:00:00.000Z" }, "shopify_deletion_retention_gap"],
    [{ version: 1, deletionContinuity: "prior_generation_unproven" }, "shopify_deletion_continuity_unproven"],
  ] as const) {
    await assert.rejects(
      extractShopifyPage({
        stream: "shopify_products",
        mode: "incremental",
        cursor: { value: JSON.stringify(cursorValue), sourceUpdatedAt: FROM },
        now: () => Date.parse(TO),
        readAllOrders: true,
        call: emptyProducts,
      }),
      (error: unknown) => error instanceof ConnectorError &&
        error.code === "CAPABILITY_UNAVAILABLE" && error.details?.reason === reason,
    );
  }
  assert.equal(resourceCalls,0,"continuity must fail before a Shopify resource request");

  const job = {
    type: "InitialBackfill",connectorId: "shopify",connectionGeneration: 4,
    phase: "recent",
  } as never;
  const inherited = shopifyInitialDeletionCursor(job, {
    connectionGeneration: 3,
    cursor: { value: JSON.stringify({ version: 1, deletionEventWatermark: FROM }) },
  });
  assert.deepEqual(JSON.parse(inherited!.value), {
    version: 1,deletionEventWatermark: FROM,deletionContinuity: "prior_generation_verified",
  });
  const unproven = shopifyInitialDeletionCursor(job, {
    connectionGeneration: 1,cursor: { value: JSON.stringify({ version: 1 }) },
  });
  assert.equal(JSON.parse(unproven!.value).deletionContinuity, "prior_generation_unproven");
});

test("complete per-order child collections are the only child-removal evidence", async () => {
  const parent = {
    id: "gid://shopify/Order/1",updatedAt: "2026-08-11T01:02:00.000Z",
    lineItems: {
      edges: [{ cursor: "line-1", node: { id: "gid://shopify/LineItem/1",quantity: 1 } }],
      pageInfo: { hasNextPage: true, endCursor: "line-1" },
    },
  };
  const partial = await extractShopifyPage({
    stream: "shopify_order_lines",mode: "initial",range: { from: FROM, to: TO },
    now: () => Date.parse(TO),readAllOrders: true,
    call: async () => ({ errors: [],data: { orders: {
      edges: [{ cursor: "order-1",node: parent }],
      pageInfo: { hasNextPage: false,endCursor: "order-1" },
    } } }),
  });
  assert.equal(partial.records.length, 1);
  assert.equal(partial.records.some(({ sourceObjectType }) => sourceObjectType === "OrderLineCollection"), false);
  const partialState = JSON.parse(partial.nextCursor!.value);
  assert.match(partialState.collectionScanId, /^[0-9a-f]{64}$/u);

  const complete = await extractShopifyPage({
    stream: "shopify_order_lines",mode: "initial",range: { from: FROM, to: TO },
    cursor: partial.nextCursor!,now: () => Date.parse(TO),readAllOrders: true,
    call: async () => ({ errors: [],data: { orders: {
      edges: [{ cursor: "order-1",node: {
        ...parent,
        lineItems: {
          edges: [{ cursor: "line-2",node: { id: "gid://shopify/LineItem/2",quantity: 1 } }],
          pageInfo: { hasNextPage: false,endCursor: "line-2" },
        },
      } }],
      pageInfo: { hasNextPage: false,endCursor: "order-1" },
    } } }),
  });
  assert.equal(complete.records.length, 2);
  const marker = complete.records.find(({ sourceObjectType }) => sourceObjectType === "OrderLineCollection");
  assert.ok(marker);
  assert.equal(marker.normalized?.fields.collectionComplete, true);
  assert.equal(marker.normalized?.fields.collectionScanId, partialState.collectionScanId);
  assert.equal(complete.records[0]?.sourceUpdatedAt, parent.updatedAt);

  // The same parent version must retain the same scan identity regardless of
  // coordinator window; otherwise an idempotent replay could delete children.
  const replay = await extractShopifyPage({
    stream: "shopify_order_lines",mode: "initial",
    range: { from: "2026-01-01T00:00:00.000Z",to: "2026-08-12T12:00:00.000Z" },
    now: () => Date.parse(TO),readAllOrders: true,
    call: async () => ({ errors: [],data: { orders: {
      edges: [{ cursor: "order-1",node: {
        ...parent,lineItems: { edges: [],pageInfo: { hasNextPage: false,endCursor: null } },
      } }],pageInfo: { hasNextPage: false,endCursor: "order-1" },
    } } }),
  });
  assert.equal(replay.records[0]?.sourceObjectType, "OrderLineCollection");
  assert.equal(replay.records[0]?.normalized?.fields.collectionScanId, partialState.collectionScanId);
});

test("runtime and migrations fence child replacement, purge, and continuity", async () => {
  const root = new URL("../../", import.meta.url);
  const [landing,migration,controlMigration,commerceCube,referenceCube,worker,route,workspace,readme] = await Promise.all([
    readFile(new URL("services/sync-workers/src/analytical-store.ts",root),"utf8"),
    readFile(new URL("infra/migrations/analytical/0155_m3_shopify_authoritative_order_line_replacement.sql",root),"utf8"),
    readFile(new URL("infra/migrations/control-plane/0135_m2_shopify_deletion_continuity_block.sql",root),"utf8"),
    readFile(new URL("cube-playground/model/cubes/shopify_commerce.yml",root),"utf8"),
    readFile(new URL("cube-playground/model/cubes/shopify_reference.yml",root),"utf8"),
    readFile(new URL("services/sync-workers/src/worker.ts",root),"utf8"),
    readFile(new URL("app/api/connections/start-ingestion/route.ts",root),"utf8"),
    readFile(new URL("services/control-plane/src/connections-workspace.ts",root),"utf8"),
    readFile(new URL("connectors/shopify/README.md",root),"utf8"),
  ]);
  for (const stream of [
    "shopify_order_lines","shopify_transactions","shopify_refund_lines",
    "shopify_fulfillments","shopify_returns",
  ]) {
    assert.equal(shopifyManifest.streams.find(({ id }) => id === stream)?.deletionStrategy, "no_absence_deletes");
  }
  assert.match(shopifyManifest.limitations.join("\n"), /complete collection observation[\s\S]*partial or fixed-cap selections fail closed/u);
  assert.match(landing, /collection\.payload_batch_id=\$4[\s\S]*collection\.collection_complete=true/u);
  assert.match(landing, /line\.collection_scan_id is distinct from current_collection\.collection_scan_id/u);
  assert.match(landing, /line\.source_updated_at<=current_collection\.retired_at/u);
  assert.match(landing, /update ingestion\.source_records[\s\S]*normalized_payload=jsonb_set/u);
  assert.equal((commerceCube.match(/COALESCE\(t\.collection_complete, false\) = false/gu) ?? []).length, 5);

  const privateCubeSql = `${commerceCube}\n${referenceCube}`;
  assert.equal(
    (privateCubeSql.match(/SELECT 1 FROM quality\.shopify_connection_queryability_blocks b/gu) ?? []).length,
    16,
    "every private Shopify cube must exclude an exact queryability block",
  );
  assert.equal((commerceCube.match(/name: distinct_protected_subjects/gu) ?? []).length,6);
  assert.match(landing,/blockShopifyConnectionQueryability[\s\S]*insert into quality\.shopify_connection_queryability_blocks/u);
  assert.match(worker,/blockShopifyConnectionQueryability[\s\S]*blockShopifyDeletionContinuity/u);

  assert.match(migration,/CREATE TABLE IF NOT EXISTS quality\.shopify_connection_queryability_blocks/u);
  assert.doesNotMatch(migration,/shopify_connection_queryability_blocks[\s\S]{0,200}REFERENCES/u);
  assert.match(migration,/GRANT UPDATE \(connection_generation,sync_run_id,reason,blocked_at\)[\s\S]*ON quality\.shopify_connection_queryability_blocks TO ingest_rw/u);
  assert.doesNotMatch(migration,/GRANT[^;]*\bUPDATE\s+ON quality\.shopify_connection_queryability_blocks TO ingest_rw/u);
  assert.doesNotMatch(migration,/GRANT[^;]*\bDELETE\b[^;]*ON quality\.shopify_connection_queryability_blocks TO ingest_rw/u);
  assert.match(migration,/DELETE FROM quality\.shopify_connection_queryability_blocks[\s\S]*purge_connection_before_shopify_child_replacements/u);
  assert.match(migration,/SELECT count\(\*\) INTO blocked_residual[\s\S]*shopify_connection_queryability_blocks/u);
  assert.match(migration,/GRANT SELECT ON quality\.shopify_connection_queryability_blocks TO semantic_ro/u);
  assert.match(migration, /FOREIGN KEY \(tenant_id,replacement_batch_id\)[\s\S]*REFERENCES ingestion\.batch_manifests/u);
  assert.match(migration, /DELETE FROM quality\.shopify_order_child_collection_replacements[\s\S]*purge_connection_before_shopify_child_replacements/u);
  assert.match(migration, /DELETE FROM quality\.shopify_order_child_collection_replacements[\s\S]*purge_tenant_before_shopify_child_replacements/u);
  assert.equal((migration.match(/activate_deletion_capability\('deletion_(?:purge|verify)'\)/gu) ?? []).length, 4);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS voided boolean NOT NULL DEFAULT false/u);
  assert.match(migration, /AND NOT refund\.voided AND NOT order_header\.voided/u);

  assert.match(controlMigration, /require_active_sync_job_lease/u);
  assert.match(controlMigration, /ingestion_activated_at=NULL[\s\S]*ingestion_blocked_reason=p_reason/u);
  assert.match(controlMigration, /SET state='blocked'/u);
  assert.match(controlMigration,/DELETE FROM control_plane\.sync_write_permits[\s\S]*connection_generation=p_connection_generation/u);
  assert.match(controlMigration,/CREATE TRIGGER preserve_shopify_deletion_continuity_block/u);
  assert.match(controlMigration,/NEW\.ingestion_blocked_reason:=OLD\.ingestion_blocked_reason/u);
  assert.match(controlMigration,/albert_start_connection_ingestion_before_shopify_continuity/u);
  assert.match(controlMigration, /GRANT EXECUTE[\s\S]*TO albert_sync_control/u);
  for (const artifact of [shopifyManifest.limitations.join("\n"),route,workspace,readme]) {
    assert.match(artifact,/Disconnect[\s\S]*verified local deletion[\s\S]*reconnect[\s\S]*Start ingestion/iu);
  }

  const error = new ConnectorError("CAPABILITY_UNAVAILABLE","gap",{
    retryable: false,details: { reason: "shopify_deletion_retention_gap" },
  });
  assert.equal(shopifyDeletionContinuityBlockReason({ connectorId: "shopify" } as never,error), "shopify_deletion_retention_gap");
  assert.equal(shopifyDeletionContinuityBlockReason({ connectorId: "square" } as never,error), null);
  const invalidFeed = new ConnectorError("REMOTE_RESPONSE_INVALID","bad event",{
    retryable: false,details: { reason: "shopify_deletion_feed_unavailable" },
  });
  assert.equal(
    shopifyDeletionContinuityBlockReason({ connectorId: "shopify" } as never,invalidFeed),
    "shopify_deletion_feed_unavailable",
  );
});
