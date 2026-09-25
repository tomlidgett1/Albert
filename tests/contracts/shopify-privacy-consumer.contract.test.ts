import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL(
  "../../infra/migrations/control-plane/0132_m8_shopify_customer_privacy_consumer.sql",
  import.meta.url,
);
const ingressPath = new URL(
  "../../infra/migrations/control-plane/0130_m7_shopify_compliance_webhook_ingress.sql",
  import.meta.url,
);

test("customer redaction uses current generation-bound verified full deletion", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /dispatch_shopify_customer_redaction/u);
  assert.match(sql, /connection_generation=privacy_case\.target_connection_generation/u);
  assert.match(sql, /'fullConnectionPurge',true/u);
  assert.match(sql, /'connectionGeneration',privacy_case\.target_connection_generation/u);
  assert.doesNotMatch(
    sql,
    /request\.status IN \([\s\S]{0,120}'completed'[\s\S]{0,300}ORDER BY request\.requested_at/u,
  );
  assert.match(sql, /JOIN control_plane\.deletion_proofs proof/u);
  assert.match(sql, /proof\.completed_at>=privacy_case\.received_at/u);
  assert.match(sql, /request\.progress->'shopify_customer_redaction'->'caseIds'/u);
  assert.match(sql, /proof\.completed_at>=privacy_case\.received_at/u);
  assert.doesNotMatch(
    sql,
    /request\.status IN \([^)]*'completed'[^)]*\)[\s\S]{0,120}ORDER BY request\.requested_at/u,
  );
});

test("ingress cardinality and redaction fence fail closed", async () => {
  const sql = await readFile(ingressPath, "utf8");
  assert.equal((sql.match(/targets:=targets\+1/gu) ?? []).length, 1);
  assert.match(sql, /targets<>jsonb_array_length\(resolved_targets\)/u);
  assert.match(sql, /document->>'topic'='customers\/redact'/u);
  assert.match(sql, /connection\.connection_generation=/u);
  assert.match(sql, /ingestion_blocked_reason='shopify_customer_redaction'/u);
});

test("queue receipt and artifact digest are not data-request delivery", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const queueCompletion = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION control_plane.complete_shopify_privacy_job"),
    sql.indexOf("CREATE OR REPLACE FUNCTION control_plane.retry_shopify_privacy_job"),
  );
  const exportCompletion = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION control_plane.complete_shopify_privacy_export"),
    sql.indexOf("CREATE OR REPLACE FUNCTION public.complete_albert_shopify_privacy_delivery"),
  );
  const deliveryCompletion = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.complete_albert_shopify_privacy_delivery"),
    sql.indexOf("REVOKE ALL ON TABLE"),
  );

  assert.doesNotMatch(queueCompletion, /SET status='completed'/u);
  assert.match(exportCompletion, /THEN 'awaiting_delivery'/u);
  assert.doesNotMatch(exportCompletion, /shopify_privacy_delivery_evidence/u);
  assert.match(deliveryCompletion, /INSERT INTO control_plane\.shopify_privacy_delivery_evidence/u);
  assert.match(deliveryCompletion, /status='completed'/u);
  const preparation = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION control_plane.prepare_shopify_customer_data_request"),
    sql.indexOf("CREATE OR REPLACE FUNCTION control_plane.complete_shopify_privacy_job"),
  );
  assert.match(preparation, /THEN 'attention_required'/u);
  assert.match(preparation, /'unresolvable_customer_identity'/u);
  assert.match(sql, /customer_reference IS NULL[\s\S]{0,120}cardinality\(privacy_case\.order_references\)=0/u);
});

test("exporter is bounded and carries queried source payloads without truncation", async () => {
  const database = await readFile(
    new URL("../../services/operator-diagnostic/src/database.ts", import.meta.url),
    "utf8",
  );
  assert.match(database, /SHOPIFY_PRIVACY_MAX_RECORDS = 50_000/u);
  assert.match(database, /SHOPIFY_PRIVACY_MAX_ARTIFACT_BYTES = 32 \* 1024 \* 1024/u);
  assert.match(database, /collection_estimates/u);
  assert.match(database, /estimated_bytes/u);
  assert.match(database, /assertShopifyPrivacyExportBounds/u);
  assert.match(database, /'payload',item\.normalized_payload/u);
  assert.match(database, /selected_metafield_values AS/u);
  assert.match(database, /source_shopify\.shopify_metafield_values/u);
  assert.match(database, /item\.owner_id=ANY\(\$3::text\[\]\)/u);
  assert.match(database, /'name','metafield_values'/u);
  assert.match(database, /FROM selected_metafield_values item/u);
  assert.match(database, /to_jsonb\(item\)/u);
  assert.doesNotMatch(database, /\.slice\(0,\s*SHOPIFY_PRIVACY_MAX/u);
});

test("privacy worker uses exact runtime capabilities and exports are operator-only", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /require_exact_runtime_login\([\s\S]*'albert_deletion_control_runtime'/u);
  assert.match(sql, /assert_operator_diagnostic_control_ready/u);
  assert.match(sql, /extensions\.albert_auth_uid\(\)/u);
  assert.doesNotMatch(sql, /auth\.uid\(\)/u);
  assert.match(sql, /FROM PUBLIC,anon,authenticated,service_role/u);
  assert.match(sql, /TO albert_deletion_control/u);
  assert.match(sql, /TO albert_operator_diagnostic_control/u);
});
