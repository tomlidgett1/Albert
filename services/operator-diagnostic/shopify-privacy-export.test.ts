import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createOperatorDiagnosticHttpHandler,
  SHOPIFY_PRIVACY_EXPORT_PATH,
  signShopifyPrivacyExportRequest,
} from "./src/http.js";
import {
  assertShopifyPrivacyExportBounds,
  PostgresOperatorDiagnosticReadStore,
  SHOPIFY_PRIVACY_MAX_ARTIFACT_BYTES,
  SHOPIFY_PRIVACY_MAX_RECORDS,
} from "./src/database.js";
import type {
  ShopifyPrivacyArtifact,
  ShopifyPrivacyExportGrant,
} from "./src/contracts.js";

const signingSecret = "operator-diagnostic-test-secret-with-more-than-32-bytes";
const exportId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const caseId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const tenantId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const connectionId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

const grant: ShopifyPrivacyExportGrant = Object.freeze({
  export_id: exportId,
  case_id: caseId,
  tenant_id: tenantId,
  connection_id: connectionId,
  customer_reference: "123",
  order_references: ["456"],
  data_request_reference: "789",
  expires_at: "2026-08-12T02:10:00.000Z",
  analytical_capability: `signed-${"x".repeat(110)}`,
});

const collections = [
  "customers","orders","order_lines","transactions","refund_lines",
  "fulfillments","returns","metafield_values","long_tail_fields",
  "normalized_source_records",
] as const;
const artifact: ShopifyPrivacyArtifact = Object.freeze({
  schemaVersion: 1,
  exportId,
  caseId,
  generatedAt: "2026-08-12T02:00:00.000Z",
  source: "albert_shopify_customer_data",
  customerReference: "123",
  orderReferences: ["456"],
  dataRequestReference: "789",
  collections: collections.map((name, index) => ({
    name,
    records: index === 0 ? [{ id: "gid://shopify/Customer/123" }] : [],
  })),
  recordCount: 1,
});

test("signed Shopify privacy export persists digest but does not fabricate delivery", async () => {
  const completions: unknown[] = [];
  const handler = createOperatorDiagnosticHttpHandler({
    signingSecret,
    controlStore: {
      claim: async () => { throw new Error("not used"); },
      complete: async () => undefined,
      claimShopifyPrivacyExport: async (received) => {
        assert.equal(received, exportId);
        return grant;
      },
      completeShopifyPrivacyExport: async (input) => { completions.push(input); },
    },
    readStore: {
      sample: async () => { throw new Error("not used"); },
      exportShopifyPrivacy: async (received) => {
        assert.deepEqual(received, grant);
        return artifact;
      },
    },
  });
  const body = JSON.stringify({ exportId });
  const headers = await signShopifyPrivacyExportRequest(body, signingSecret);
  const response = await handler(new Request(`https://internal${SHOPIFY_PRIVACY_EXPORT_PATH}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body,
  }));
  const payload = await response.json() as Readonly<{ artifact: ShopifyPrivacyArtifact; artifactSha256: string }>;
  const expectedDigest = createHash("sha256").update(JSON.stringify(artifact), "utf8").digest("hex");

  assert.equal(response.status, 200);
  assert.deepEqual(payload.artifact, artifact);
  assert.equal(payload.artifactSha256, expectedDigest);
  assert.deepEqual(completions, [{
    exportId,
    status: "completed",
    artifactSha256: expectedDigest,
    recordCount: 1,
  }]);
  assert.equal(JSON.stringify(completions).includes("delivery"), false);
});

test("unsigned privacy export cannot claim a one-use grant", async () => {
  let claims = 0;
  const handler = createOperatorDiagnosticHttpHandler({
    signingSecret,
    controlStore: {
      claim: async () => { throw new Error("not used"); },
      complete: async () => undefined,
      claimShopifyPrivacyExport: async () => { claims += 1; return grant; },
    },
    readStore: { sample: async () => { throw new Error("not used"); } },
  });
  const response = await handler(new Request(`https://internal${SHOPIFY_PRIVACY_EXPORT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exportId }),
  }));

  assert.equal(response.status, 401);
  assert.equal(claims, 0);
});

test("privacy export fails closed before database access for HMAC-only identity", async () => {
  let databaseAccesses = 0;
  const store = new PostgresOperatorDiagnosticReadStore({
    connect: async () => {
      databaseAccesses += 1;
      throw new Error("must not connect");
    },
  });

  await assert.rejects(
    store.exportShopifyPrivacy({
      ...grant,
      customer_reference: null,
      order_references: [],
    }),
    (error: unknown) =>
      (error as Readonly<{ diagnosticCode?: unknown }>).diagnosticCode ===
        "SHOPIFY_PRIVACY_UNRESOLVABLE_IDENTITY",
  );
  assert.equal(databaseAccesses, 0);
});

test("privacy export bounds reject overflow instead of truncating", () => {
  assert.doesNotThrow(() => assertShopifyPrivacyExportBounds(
    BigInt(SHOPIFY_PRIVACY_MAX_RECORDS),
    BigInt(SHOPIFY_PRIVACY_MAX_ARTIFACT_BYTES),
  ));
  assert.throws(
    () => assertShopifyPrivacyExportBounds(BigInt(SHOPIFY_PRIVACY_MAX_RECORDS + 1), 1n),
    (error: unknown) =>
      (error as Readonly<{ diagnosticCode?: unknown }>).diagnosticCode ===
        "SHOPIFY_PRIVACY_EXPORT_TOO_LARGE",
  );
  assert.throws(
    () => assertShopifyPrivacyExportBounds(1n, BigInt(SHOPIFY_PRIVACY_MAX_ARTIFACT_BYTES + 1)),
    (error: unknown) =>
      (error as Readonly<{ diagnosticCode?: unknown }>).diagnosticCode ===
        "SHOPIFY_PRIVACY_EXPORT_TOO_LARGE",
  );
});
