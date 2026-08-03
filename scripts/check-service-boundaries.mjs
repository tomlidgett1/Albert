import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sync=await readFile(".albert-build/services/sync-worker.js","utf8");
const transform=await readFile(".albert-build/services/transform-worker.js","utf8");
const webhook=await readFile(".albert-build/services/webhook-gateway.js","utf8");

for(const required of ["albert_sync_control","ingest_rw"]){
  assert.equal(sync.includes(required),true,`sync-worker bundle is missing its required database boundary: ${required}`);
}

for(const forbidden of [
  "TRANSFORM_DATABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "set local role transform_rw",
  "CanonicalTransformPipeline",
]){
  assert.equal(sync.includes(forbidden),false,`sync-worker bundle crossed transform boundary: ${forbidden}`);
}

for(const forbidden of [
  "ANALYTICAL_DATABASE_URL",
  "TRANSFORM_DATABASE_URL",
  "TOKEN_ENCRYPTION_KEY",
  "LIGHTSPEED_CLIENT_SECRET",
  "XERO_CLIENT_SECRET",
  "DEPUTY_CLIENT_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CredentialVault",
  "ProductionConnectorFactory",
  "oauth_token_refs",
  "enqueue_sync_job",
  "assert_pgmq_ready",
  "XeroConnector",
]){
  assert.equal(webhook.includes(forbidden),false,`webhook-gateway bundle crossed its public-edge boundary: ${forbidden}`);
}

for(const required of [
  "albert_webhook_control",
  "SUPABASE_STORAGE_S3_ENDPOINT",
  "SUPABASE_STORAGE_S3_ACCESS_KEY_ID",
  "WEBHOOK_INBOX_ENCRYPTION_KEY",
  "WEBHOOK_INBOX_ENCRYPTION_KEY_ID",
  "assert_deputy_webhook_gateway_ready",
  "accept_xero_webhook_inbox",
  "claim_xero_webhook_inbox",
  "enqueue_xero_webhook_gap_sweeps",
  "IfNoneMatch",
]){
  assert.equal(webhook.includes(required),true,`webhook-gateway bundle is missing its storage-only boundary: ${required}`);
}

for(const forbidden of [
  "ANALYTICAL_DATABASE_URL",
  "TOKEN_ENCRYPTION_KEY",
  "LIGHTSPEED_CLIENT_SECRET",
  "XERO_CLIENT_SECRET",
  "DEPUTY_CLIENT_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CredentialVault",
  "ProductionConnectorFactory",
  "RawBatchWriter",
  "oauth_token_refs",
]){
  assert.equal(transform.includes(forbidden),false,`transform-worker bundle crossed credential boundary: ${forbidden}`);
}
assert.equal(
  transform.includes('"CONTROL_PLANE_DATABASE_URL"'),
  false,
  "transform-worker bundle must require its dedicated control-plane login",
);

for(const required of [
  "TRANSFORM_CONTROL_PLANE_DATABASE_URL",
  "TRANSFORM_DATABASE_URL",
  "set local role transform_rw",
  "set local role albert_transform_control",
  "CanonicalTransformPipeline",
]){
  assert.equal(transform.includes(required),true,`transform-worker bundle is missing its required boundary: ${required}`);
}
