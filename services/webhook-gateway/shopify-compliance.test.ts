import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import type { PostgresQueryClient } from "../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "../sync-workers/src/database.js";
import { createWebhookAttestor } from "./src/attestation.js";
import {
  ShopifyComplianceWebhookIngress,
  ShopifyComplianceWebhookStore,
  ShopifyWebhookValidationError,
} from "./src/shopify-compliance.js";

const clientSecret = "shopify-compliance-client-secret-for-tests";
const receivedAt = "2026-08-12T04:00:00.000Z";
const inboxId = "01J00000000000000000000001";

class Database implements TransactionalPostgres {
  readonly calls: Readonly<{ sql: string; values: readonly unknown[] }>[] = [];

  transaction<T>(work: (client: PostgresQueryClient) => Promise<T>): Promise<T> {
    return work(this);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<Readonly<{ rows: readonly Row[] }>> {
    (this.calls as { sql: string; values: readonly unknown[] }[]).push({ sql, values });
    return {
      rows: [{
        inbox_id: inboxId,
        status: "dispatched",
        duplicate: false,
        target_count: 1,
      } as unknown as Row],
    };
  }
}

function ingress(db = new Database()) {
  const attestor = createWebhookAttestor({
    keyId: "webhook-v1",
    encodedSecret: Buffer.alloc(32, 11).toString("base64url"),
    now: () => Date.parse(receivedAt),
    nonce: () => Buffer.alloc(16, 3).toString("base64url"),
  });
  return {
    db,
    value: new ShopifyComplianceWebhookIngress({
      clientSecret,
      store: new ShopifyComplianceWebhookStore(db, attestor),
    }),
  };
}

function requestHeaders(topic: string, body: string, signature?: string): Headers {
  return new Headers({
    "content-type": "application/json",
    "x-shopify-topic": topic,
    "x-shopify-api-version": "2026-07",
    "x-shopify-shop-domain": "demo.myshopify.com",
    "x-shopify-webhook-id": `delivery-${topic.replaceAll("/", "-")}`,
    "x-shopify-event-id": "merchant-action-1",
    "x-shopify-hmac-sha256": signature ?? createHmac("sha256", clientSecret)
      .update(body)
      .digest("base64"),
  });
}

test("Shopify customer privacy delivery is HMAC verified and reduced to a non-plaintext attested envelope", async () => {
  const fixture = ingress();
  const body = JSON.stringify({
    shop_id: 954889,
    shop_domain: "demo.myshopify.com",
    customer: { id: 191167, email: "person@example.com", phone: "+61 400 000 000" },
    orders_to_redact: [299938, 280263],
  });
  const accepted = await fixture.value.accept(
    new TextEncoder().encode(body),
    requestHeaders("customers/redact", body),
    receivedAt,
  );
  assert.equal(accepted.status, "dispatched");
  assert.equal(fixture.db.calls.length, 1);
  assert.match(fixture.db.calls[0]!.sql, /accept_attested_shopify_compliance_webhook/u);
  const document = JSON.parse(String(fixture.db.calls[0]!.values[0])) as Record<string, unknown>;
  assert.equal(document.topic, "customers/redact");
  assert.equal(document.customerReference, "191167");
  assert.deepEqual(document.orderReferences, ["280263", "299938"]);
  assert.match(String(document.customerContactHmac), /^[0-9a-f]{64}$/u);
  assert.match(String(document.shopReferenceHmac), /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(document), /person@example\.com|\+61 400|"body"/u);
});

test("Shopify invalid HMAC fails before any durable call", async () => {
  const fixture = ingress();
  const body = JSON.stringify({ shop_id: 954889, shop_domain: "demo.myshopify.com" });
  await assert.rejects(
    fixture.value.accept(
      new TextEncoder().encode(body),
      requestHeaders("shop/redact", body, Buffer.alloc(32, 9).toString("base64")),
      receivedAt,
    ),
    (error: unknown) => error instanceof ShopifyWebhookValidationError
      && error.code === "signature_invalid",
  );
  assert.equal(fixture.db.calls.length, 0);
});

test("all mandatory privacy and uninstall topics reach the attested durable boundary", async () => {
  const fixtures = [
    {
      topic: "customers/data_request",
      payload: {
        shop_id: 954889,
        shop_domain: "demo.myshopify.com",
        customer: { id: 191167 },
        orders_requested: [299938],
        data_request: { id: 9999 },
      },
    },
    {
      topic: "customers/redact",
      payload: {
        shop_id: 954889,
        shop_domain: "demo.myshopify.com",
        customer: { id: 191167 },
        orders_to_redact: [299938],
      },
    },
    {
      topic: "shop/redact",
      payload: { shop_id: 954889, shop_domain: "demo.myshopify.com" },
    },
    {
      topic: "app/uninstalled",
      payload: { id: 954889, name: "Demo Store" },
    },
  ] as const;
  for (const item of fixtures) {
    const fixture = ingress();
    const body = JSON.stringify(item.payload);
    await fixture.value.accept(
      new TextEncoder().encode(body),
      requestHeaders(item.topic, body),
      receivedAt,
    );
    assert.equal(fixture.db.calls.length, 1, item.topic);
    const document = JSON.parse(String(fixture.db.calls[0]!.values[0])) as Record<string, unknown>;
    assert.equal(document.topic, item.topic);
  }
});

test("operational Shopify topics and non-pinned API versions cannot enter the compliance inbox", async () => {
  const body = JSON.stringify({ id: 42 });
  const operational = ingress();
  await assert.rejects(
    operational.value.accept(
      new TextEncoder().encode(body),
      requestHeaders("orders/create", body),
      receivedAt,
    ),
    (error: unknown) => error instanceof ShopifyWebhookValidationError
      && error.code === "topic_unsupported",
  );
  const wrongVersion = ingress();
  const headers = requestHeaders("app/uninstalled", body);
  headers.set("x-shopify-api-version", "2026-04");
  await assert.rejects(
    wrongVersion.value.accept(new TextEncoder().encode(body), headers, receivedAt),
    (error: unknown) => error instanceof ShopifyWebhookValidationError
      && error.code === "api_version_invalid",
  );
  assert.equal(operational.db.calls.length, 0);
  assert.equal(wrongVersion.db.calls.length, 0);
});
