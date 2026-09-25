import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("Shopify compliance ingress is minimal, attested, and isolated from ingestion", async () => {
  const [migration, handler, compliance, bootstrap, manualActivation, runtime] = await Promise.all([
    readFile(new URL("infra/migrations/control-plane/0130_m7_shopify_compliance_webhook_ingress.sql", root), "utf8"),
    readFile(new URL("services/webhook-gateway/src/handler.ts", root), "utf8"),
    readFile(new URL("services/webhook-gateway/src/shopify-compliance.ts", root), "utf8"),
    readFile(new URL("infra/bootstrap/control_plane_role.sql", root), "utf8"),
    readFile(new URL("infra/migrations/control-plane/0123_m2_shopify_generation_activation.sql", root), "utf8"),
    readFile(new URL("deploy/runtime-contract.json", root), "utf8"),
  ]);
  assert.match(handler, /\/v1\/webhooks\/shopify\/compliance/u);
  assert.match(compliance, /customers\/data_request[\s\S]*customers\/redact[\s\S]*shop\/redact[\s\S]*app\/uninstalled/u);
  assert.match(compliance, /createHmac\("sha256", input\.clientSecret\)\.update\(input\.body\)/u);
  assert.match(compliance, /timingSafeEqual/u);
  assert.match(migration, /accept_attested_shopify_compliance_webhook/u);
  assert.match(migration, /consume_webhook_attestation\([\s\S]*'shopify\.accept'/u);
  assert.match(migration, /customers\/data_request[\s\S]*pgmq\.send\([\s\S]*albert_shopify_privacy/u);
  assert.match(migration, /shop\/redact','app\/uninstalled'[\s\S]*enqueue_deletion_request/u);
  assert.match(migration, /ingestion_activated_at=NULL[\s\S]*ingestion_activated_generation=NULL/u);
  assert.doesNotMatch(migration, /enqueue_sync_job|InitialBackfill|IncrementalSync|ReconciliationSweep/u);
  assert.doesNotMatch(migration, /raw_object|raw_payload|source_shopify/u);
  assert.doesNotMatch(migration, /customer_email|customer_phone|email text|phone text/u);
  assert.match(bootstrap, /albert_install_shopify_privacy_queue/u);
  assert.match(manualActivation, /ingestion has not been activated for this connection generation/u);
  const contract = JSON.parse(runtime) as { runtimes: { "webhook-gateway": { requiredSecretNames: string[] } } };
  assert.ok(contract.runtimes["webhook-gateway"].requiredSecretNames.includes("SHOPIFY_CLIENT_SECRET"));
});

test("Shopify app-specific subscription template pins compliance and uninstall only", async () => {
  const config = await readFile(new URL("connectors/shopify/shopify.app.toml.example", root), "utf8");
  assert.match(config, /api_version = "2026-07"/u);
  assert.match(config, /compliance_topics = \["customers\/data_request", "customers\/redact", "shop\/redact"\]/u);
  assert.match(config, /topics = \["app\/uninstalled"\]/u);
  assert.doesNotMatch(config, /orders\/|products\/|inventory_/u);
});

