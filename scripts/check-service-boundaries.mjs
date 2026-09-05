import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sync=await readFile(".albert-build/services/sync-worker.js","utf8");
const webhook=await readFile(".albert-build/services/webhook-gateway.js","utf8");
const deletion=await readFile(".albert-build/services/deletion-worker.js","utf8");
const diagnostic=await readFile(".albert-build/services/operator-diagnostic.js","utf8");
const codex=await readFile(".albert-build/services/codex-runtime.js","utf8");
const imessage=await readFile(".albert-build/services/imessage-bridge.js","utf8");
const buildIdentity=JSON.parse(await readFile(".albert-build/services/build-identity.json","utf8"));

for(const forbidden of [
  "ANALYTICAL_DATABASE_URL",
  "OPENAI_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "LIGHTSPEED_CLIENT_SECRET",
  "DEPUTY_CLIENT_SECRET",
  "XERO_CLIENT_SECRET",
  "set local role semantic_ro",
  "CredentialVault",
  "ProductionConnectorFactory",
]){
}

for(const required of ["albert_sync_control","ingest_rw"]){
  assert.equal(sync.includes(required),true,`sync-worker bundle is missing its required database boundary: ${required}`);
}
for(const required of [
  "SUPABASE_STORAGE_S3_LEGACY_ANON_KEY",
  "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
  "PutObjectCommand",
  "GetObjectCommand",
  "sessionToken",
]){
  assert.equal(sync.includes(required),true,`sync-worker bundle is missing its RLS-scoped raw Storage boundary: ${required}`);
}

for(const forbidden of [
  "TRANSFORM_DATABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "set local role transform_rw",
  "CanonicalTransformPipeline",
  "DeleteObjectsCommand",
  "ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD",
  "ALBERT_RAW_STORAGE_DELETION_PASSWORD",
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
  "SUPABASE_STORAGE_S3_LEGACY_ANON_KEY",
  "ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD",
  "WEBHOOK_INBOX_ENCRYPTION_KEY",
  "WEBHOOK_INBOX_ENCRYPTION_KEY_ID",
  "WEBHOOK_ATTESTATION_KEY_ID",
  "WEBHOOK_ATTESTATION_SECRET",
  "assert_attested_webhook_gateway_ready",
  "resolve_attested_deputy_webhook_material",
  "resolve_attested_xero_webhook_connections",
  "reserve_attested_webhook_receipt",
  "attach_attested_webhook_raw",
  "finalize_attested_deputy_webhook",
  "enqueue_attested_xero_webhook_incremental",
  "fail_attested_webhook_receipt",
  "accept_attested_xero_webhook_inbox",
  "claim_attested_xero_webhook_inbox",
  "renew_attested_xero_webhook_inbox_lease",
  "record_attested_xero_webhook_sequence",
  "record_attested_xero_webhook_connection_delivery",
  "enqueue_attested_xero_webhook_gap_sweeps",
  "complete_attested_xero_webhook_inbox",
  "fail_attested_xero_webhook_inbox",
  "attested_xero_webhook_inbox_health",
  "IfNoneMatch",
  "sessionToken",
]){
  assert.equal(webhook.includes(required),true,`webhook-gateway bundle is missing its storage-only boundary: ${required}`);
}
for(const forbidden of [
  "DeleteObjectsCommand",
  "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
  "ALBERT_RAW_STORAGE_DELETION_PASSWORD",
]){
  assert.equal(webhook.includes(forbidden),false,`webhook-gateway bundle crossed its raw Storage command boundary: ${forbidden}`);
}



for(const forbidden of [
  "SUPABASE_SERVICE_ROLE_KEY",
  "TOKEN_ENCRYPTION_KEY",
  "LIGHTSPEED_CLIENT_SECRET",
  "XERO_CLIENT_SECRET",
  "DEPUTY_CLIENT_SECRET",
  "SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY",
  "CONTROL_PLANE_MIGRATION_URL",
  "ANALYTICAL_MIGRATION_URL",
]){
}

for(const required of [
  "OPERATOR_DIAGNOSTIC_CONTROL_PLANE_DATABASE_URL",
  "OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL",
  "albert_operator_diagnostic_control",
  "SET LOCAL ROLE diagnostic_ro",
  "claim_operator_diagnostic_reveal",
]){
  assert.equal(diagnostic.includes(required),true,`operator-diagnostic bundle is missing its required boundary: ${required}`);
}
for(const forbidden of [
  "OPENAI_API_KEY",
  "ALBERT_SEMANTIC_SIGNING_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "LIGHTSPEED_CLIENT_SECRET",
  "DEPUTY_CLIENT_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "semantic_ro",
]){
  assert.equal(diagnostic.includes(forbidden),false,`operator-diagnostic bundle crossed a forbidden boundary: ${forbidden}`);
}

for(const required of [
  "ALBERT_CODEX_RUNTIME_SIGNING_SECRET",
  "ALBERT_OMNI_JOB_DATABASE_URL",
  "CUBE_API_URL",
  "OPENAI_API_KEY",
  "albert_codex_tab",
  "run_semantic_query",
]){
  assert.equal(codex.includes(required),true,`codex-runtime bundle is missing its required boundary: ${required}`);
}
for(const forbidden of [
  "process.env.CUBEJS_API_SECRET",
  "process.env.CONTROL_PLANE_DATABASE_URL",
  "process.env.ANALYTICAL_DATABASE_URL",
  "process.env.SUPABASE_SERVICE_ROLE_KEY",
  "process.env.TOKEN_ENCRYPTION_KEY",
  "process.env.LIGHTSPEED_CLIENT_SECRET",
  "process.env.XERO_CLIENT_SECRET",
  "process.env.DEPUTY_CLIENT_SECRET",
  "diagnostic_ro",
  "ingest_rw",
  "transform_rw",
]){
  assert.equal(codex.includes(forbidden),false,`codex-runtime crossed a forbidden boundary: ${forbidden}`);
}

for(const forbidden of [
  "TOKEN_ENCRYPTION_KEY",
  "LIGHTSPEED_CLIENT_SECRET",
  "DEPUTY_CLIENT_SECRET",
  "XERO_WEBHOOK_SIGNING_KEY",
  "WEBHOOK_INBOX_ENCRYPTION_KEY",
  "SUPABASE_STORAGE_S3_LEGACY_ANON_KEY",
  "DELETION_PROOF_HMAC_KEY",
  "ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET",
  "OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL",
  "diagnostic_ro",
  "ingest_rw",
  "transform_rw",
  "deletion_rw",
]){
}

// The iMessage bridge is a conversation caller (web-equivalent trust): it may
// hold the Cube signing secret, Linq credentials, and the owner-session
// Supabase keys, but never raw database URLs, connector secrets, or ingestion
// role vocabulary.
for(const required of [
  "LINQ_WEBHOOK_SIGNING_SECRET",
  "LINQ_API_TOKEN",
  "ALBERT_IMESSAGE_ALLOWED_SENDERS",
  "CUBEJS_API_SECRET",
  "ALBERT_CODEX_RUNTIME_SIGNING_SECRET",
  "begin_albert_turn",
  "albert_answer_event_append",
]){
  assert.equal(imessage.includes(required),true,`imessage-bridge bundle is missing its required boundary: ${required}`);
}
for(const forbidden of [
  "process.env.CONTROL_PLANE_DATABASE_URL",
  "process.env.ANALYTICAL_DATABASE_URL",
  "TOKEN_ENCRYPTION_KEY",
  "LIGHTSPEED_CLIENT_SECRET",
  "XERO_CLIENT_SECRET",
  "DEPUTY_CLIENT_SECRET",
  "SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY",
  "diagnostic_ro",
  "ingest_rw",
  "transform_rw",
  "deletion_rw",
]){
  assert.equal(imessage.includes(forbidden),false,`imessage-bridge bundle crossed a forbidden boundary: ${forbidden}`);
}

for(const required of [
  "set local role albert_deletion_control",
  "set local role deletion_rw",
  "DELETION_ANALYTICAL_DATABASE_URL",
  "SUPABASE_STORAGE_S3_LEGACY_ANON_KEY",
  "ALBERT_RAW_STORAGE_DELETION_PASSWORD",
  "DeleteObjectsCommand",
  "ListObjectsV2Command",
  "sessionToken",
  "TOKEN_ENCRYPTION_KEY",
  "DELETION_PROOF_HMAC_KEY",
]){
  assert.equal(deletion.includes(required),true,`deletion-worker bundle is missing its required boundary: ${required}`);
}
for(const forbidden of [
  "OPENAI_API_KEY",
  "ALBERT_SEMANTIC_SIGNING_SECRET",
  "DEPUTY_CLIENT_SECRET",
  "XERO_WEBHOOK_SIGNING_KEY",
  "WEBHOOK_INBOX_ENCRYPTION_KEY",
  "ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET",
  "OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL",
  "semantic_ro",
  "diagnostic_ro",
  "ingest_rw",
  "transform_rw",
  "PutObjectCommand",
  "GetObjectCommand",
  "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
  "ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD",
]){
  assert.equal(deletion.includes(forbidden),false,`deletion-worker bundle crossed a forbidden boundary: ${forbidden}`);
}

for(const [name,bundle] of Object.entries({sync,webhook,deletion,diagnostic})){
  assert.match(buildIdentity.buildSha,/^(?:development|[a-f0-9]{40})$/u,"service build identity is invalid");
  assert.equal(bundle.includes(buildIdentity.buildSha),true,`${name} does not contain the recorded compile-time build identity`);
  assert.equal(bundle.includes("__ALBERT_SERVICE_BUILD_SHA__"),false,`${name} retained an unresolved build-identity placeholder`);
  assert.equal(bundle.includes("does not match the service image build identity"),true,`${name} does not fail closed on runtime relabelling`);
  assert.equal(bundle.includes("SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY"),false,`${name} retained the RLS-bypassing generated S3 credential vocabulary`);
  assert.equal(bundle.includes("SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY"),false,`${name} contains the protected Auth administrator key name`);
}
