import {
  operatorDiagnosticGrantSchema,
  operatorDiagnosticSampleSchema,
  protectedDogfoodOnboardingReceiptRequestSchema,
  protectedDogfoodOnboardingReceiptSchema,
  shopifyPrivacyArtifactSchema,
  shopifyPrivacyExportGrantSchema,
  targetMatchesStage,
  type OperatorDiagnosticGrant,
  type OperatorDiagnosticSample,
  type ProtectedDogfoodOnboardingReceipt,
  type ProtectedDogfoodOnboardingReceiptRequest,
  type ShopifyPrivacyArtifact,
  type ShopifyPrivacyExportGrant,
} from "./contracts.js";

type Row = Readonly<Record<string, unknown>>;

export interface DiagnosticPgClient {
  query(sql: string, parameters?: readonly unknown[]): Promise<Readonly<{ rows: readonly Row[] }>>;
  release(): void;
}

export interface DiagnosticPgPool {
  connect(): Promise<DiagnosticPgClient>;
  end?(): Promise<void>;
}

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const SENSITIVE_COLUMN = /(?:^|_)(?:access|refresh|oauth|auth|authorization|bearer|token|secret|password|passcode|credential|private_key|api_key|cookie|headers?)(?:_|$)/u;
const EXCLUDED_TYPES = new Set(["json", "jsonb", "bytea"]);
const MAX_COLUMNS = 32;
const CELL_CHARACTER_LIMIT = 500;
export const SHOPIFY_PRIVACY_MAX_RECORDS = 50_000;
export const SHOPIFY_PRIVACY_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

function identifier(value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error("Diagnostic target contains an unsafe identifier.");
  return `"${value}"`;
}

function databaseErrorCode(error: unknown): string {
  const candidate = error as Readonly<{ code?: unknown; diagnosticCode?: unknown }>;
  for (const value of [candidate?.diagnosticCode, candidate?.code]) {
    if (typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value)) return value;
  }
  return "DIAGNOSTIC_QUERY_FAILED";
}

function diagnosticFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { diagnosticCode: code });
}

export function assertShopifyPrivacyExportBounds(
  recordCount: bigint,
  estimatedBytes: bigint,
): void {
  if (recordCount < 0n || estimatedBytes < 0n) {
    throw diagnosticFailure(
      "SHOPIFY_PRIVACY_EXPORT_ESTIMATE_INVALID",
      "Shopify privacy export estimate is invalid.",
    );
  }
  if (recordCount > BigInt(SHOPIFY_PRIVACY_MAX_RECORDS) ||
      estimatedBytes > BigInt(SHOPIFY_PRIVACY_MAX_ARTIFACT_BYTES)) {
    throw diagnosticFailure(
      "SHOPIFY_PRIVACY_EXPORT_TOO_LARGE",
      "Shopify privacy export exceeds its safety bound.",
    );
  }
}

function nonnegativeBigInt(value: unknown, label: string): bigint {
  const normalized = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!/^(0|[1-9][0-9]*)$/u.test(normalized)) {
    throw diagnosticFailure(
      "SHOPIFY_PRIVACY_EXPORT_ESTIMATE_INVALID",
      `Shopify privacy ${label} estimate is invalid.`,
    );
  }
  return BigInt(normalized);
}

export class PostgresOperatorDiagnosticControlStore {
  constructor(private readonly pool: DiagnosticPgPool) {}

  async claim(revealId: string): Promise<OperatorDiagnosticGrant> {
    return this.inRole(async (client) => {
      const result = await client.query(
        "SELECT control_plane.claim_operator_diagnostic_reveal($1) AS grant",
        [revealId],
      );
      return operatorDiagnosticGrantSchema.parse(result.rows[0]?.grant);
    });
  }

  async complete(input: Readonly<{
    revealId: string;
    status: "completed" | "failed";
    rowCount: number;
    errorCode?: string;
  }>): Promise<void> {
    await this.inRole(async (client) => {
      await client.query(
        "SELECT control_plane.complete_operator_diagnostic_reveal($1,$2,$3,$4)",
        [input.revealId, input.status, input.rowCount, input.errorCode ?? null],
      );
    });
  }

  async claimShopifyPrivacyExport(exportId: string): Promise<ShopifyPrivacyExportGrant> {
    return this.inRole(async (client) => {
      const result = await client.query(
        "SELECT control_plane.claim_shopify_privacy_export($1) AS grant",
        [exportId],
      );
      return shopifyPrivacyExportGrantSchema.parse(result.rows[0]?.grant);
    });
  }

  async completeShopifyPrivacyExport(input: Readonly<{
    exportId: string;
    status: "completed" | "failed";
    artifactSha256?: string;
    recordCount?: number;
    errorCode?: string;
  }>): Promise<void> {
    await this.inRole(async (client) => {
      await client.query(
        "SELECT control_plane.complete_shopify_privacy_export($1,$2,$3,$4,$5)",
        [
          input.exportId,
          input.status,
          input.artifactSha256 ?? null,
          input.recordCount ?? null,
          input.errorCode ?? null,
        ],
      );
    });
  }

  async completeOnboardingReceipt(
    untrustedInput: ProtectedDogfoodOnboardingReceiptRequest,
  ): Promise<ProtectedDogfoodOnboardingReceipt> {
    const input = protectedDogfoodOnboardingReceiptRequestSchema.parse(untrustedInput);
    return this.inRole(async (client) => {
      const result = await client.query(
        `SELECT control_plane.complete_protected_dogfood_onboarding_receipt(
           $1::text,$2::uuid,$3::text,$4::text,$5::text
         ) AS receipt`,
        [
          input.journeyId,
          input.userId,
          input.tenantId,
          input.browserNonceHash,
          input.userAgentHash,
        ],
      );
      return protectedDogfoodOnboardingReceiptSchema.parse(result.rows[0]?.receipt);
    });
  }

  async ready(): Promise<boolean> {
    try {
      return await this.inRole(async (client) => {
        const result = await client.query(
          `SELECT control_plane.assert_operator_diagnostic_control_ready()
               AND control_plane.assert_analytical_capability_issuer_ready()
               AND to_regprocedure('control_plane.claim_shopify_privacy_export(text)') IS NOT NULL
               AND to_regprocedure(
                 'control_plane.complete_shopify_privacy_export(text,text,text,integer,text)'
               ) IS NOT NULL AS ready`,
        );
        return result.rows[0]?.ready === true;
      });
    } catch {
      return false;
    }
  }

  private async inRole<T>(operation: (client: DiagnosticPgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE albert_operator_diagnostic_control");
      await client.query("SELECT set_config('statement_timeout','2000ms',true)");
      await client.query("SELECT control_plane.assert_operator_diagnostic_control_ready()");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep original failure */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresOperatorDiagnosticReadStore {
  constructor(private readonly pool: DiagnosticPgPool) {}

  async sample(untrustedGrant: OperatorDiagnosticGrant): Promise<OperatorDiagnosticSample> {
    const grant = operatorDiagnosticGrantSchema.parse(untrustedGrant);
    if (!targetMatchesStage(grant)) throw new Error("Diagnostic grant stage does not match its target schema.");
    const schemaName = identifier(grant.schema_name);
    const tableName = identifier(grant.table_name);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await this.assertRuntimeIdentity(client);
      await client.query("SET LOCAL ROLE diagnostic_ro");
      await client.query(
        "SELECT set_config('albert.tenant_capability',$1,true)",
        [grant.analytical_capability],
      );
      await client.query("SELECT set_config('statement_timeout','2000ms',true)");
      await client.query("SELECT set_config('lock_timeout','500ms',true)");
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('deletion:'||$1,0))",
        [grant.tenant_id],
      );
      const metadata = await client.query(
        `SELECT column_name,data_type
           FROM information_schema.columns
          WHERE table_schema=$1 AND table_name=$2
          ORDER BY ordinal_position`,
        [grant.schema_name, grant.table_name],
      );
      const tenantColumn = metadata.rows.some((row) => row.column_name === "tenant_id");
      if (!tenantColumn) throw new Error("Diagnostic target is not tenant scoped.");
      const candidates = metadata.rows.filter((row) => {
        const column = typeof row.column_name === "string" ? row.column_name : "";
        const dataType = typeof row.data_type === "string" ? row.data_type : "";
        return column !== "tenant_id" && SAFE_IDENTIFIER.test(column) &&
          !SENSITIVE_COLUMN.test(column) && !EXCLUDED_TYPES.has(dataType);
      });
      const selected = candidates.slice(0, MAX_COLUMNS).map((row) => String(row.column_name));
      if (!selected.length) throw new Error("Diagnostic target has no reveal-safe scalar columns.");
      const projection = selected.map((column) => {
        const quoted = identifier(column);
        return `CASE WHEN ${quoted} IS NULL THEN NULL ELSE left(${quoted}::text,${CELL_CHARACTER_LIMIT}) END AS ${quoted}`;
      }).join(",");
      // Identifiers come exclusively from the one-use pipeline_stats grant and
      // information_schema, then pass the strict identifier grammar above.
      // Tenant and limit remain ordinary query parameters.
      const result = await client.query(
        `SELECT ${projection} FROM ${schemaName}.${tableName} WHERE tenant_id=$1 LIMIT $2`,
        [grant.tenant_id, grant.row_limit],
      );
      await client.query("COMMIT");
      const rows = result.rows.map((row) => Object.fromEntries(selected.map((column) => {
        const value = row[column];
        return [column, value === null || value === undefined ? null : String(value)];
      })));
      return operatorDiagnosticSampleSchema.parse({
        revealId: grant.reveal_id,
        stage: grant.pipeline_stage,
        schemaName: grant.schema_name,
        tableName: grant.table_name,
        columns: selected,
        rows,
        rowCount: rows.length,
        excludedColumnCount: metadata.rows.length - 1 - selected.length,
        cellCharacterLimit: CELL_CHARACTER_LIMIT,
      });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep original failure */ }
      const wrapped = new Error("Diagnostic query failed.");
      Object.assign(wrapped, { diagnosticCode: databaseErrorCode(error) });
      throw wrapped;
    } finally {
      client.release();
    }
  }

  async exportShopifyPrivacy(
    untrustedGrant: ShopifyPrivacyExportGrant,
    generatedAt = new Date().toISOString(),
  ): Promise<ShopifyPrivacyArtifact> {
    const grant = shopifyPrivacyExportGrantSchema.parse(untrustedGrant);
    const customerCandidates = grant.customer_reference === null
      ? []
      : [grant.customer_reference, `gid://shopify/Customer/${grant.customer_reference}`];
    const orderCandidates = grant.order_references.flatMap((reference) => [
      reference,
      `gid://shopify/Order/${reference}`,
    ]);
    if (customerCandidates.length === 0 && orderCandidates.length === 0) {
      throw diagnosticFailure(
        "SHOPIFY_PRIVACY_UNRESOLVABLE_IDENTITY",
        "Shopify privacy request has no addressable identifiers.",
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await this.assertRuntimeIdentity(client);
      await client.query("SET LOCAL ROLE diagnostic_ro");
      await client.query(
        "SELECT set_config('albert.tenant_capability',$1,true)",
        [grant.analytical_capability],
      );
      await client.query("SELECT set_config('statement_timeout','45000ms',true)");
      await client.query("SELECT set_config('lock_timeout','2000ms',true)");
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('deletion:'||$1,0))",
        [grant.tenant_id],
      );
      const estimate = await client.query(
        `WITH RECURSIVE
         selected_customers AS (
           SELECT customer.*
             FROM source_shopify.shopify_customers customer
            WHERE customer.tenant_id=$1 AND customer.connection_id=$2
              AND (customer.id=ANY($3::text[])
                OR customer.legacy_resource_id=ANY($3::text[])
                OR customer.source_record_id=ANY($3::text[]))
         ),
         selected_orders AS (
           SELECT orders.*
             FROM source_shopify.shopify_orders orders
            WHERE orders.tenant_id=$1 AND orders.connection_id=$2
              AND (orders.id=ANY($4::text[])
                OR orders.legacy_resource_id=ANY($4::text[])
                OR orders.source_record_id=ANY($4::text[])
                OR orders.customer_id=ANY($3::text[]))
         ),
         relevant_order_ids(value) AS (
           SELECT unnest($4::text[])
           UNION SELECT id FROM selected_orders WHERE id IS NOT NULL
           UNION SELECT legacy_resource_id FROM selected_orders WHERE legacy_resource_id IS NOT NULL
           UNION SELECT source_record_id FROM selected_orders WHERE source_record_id IS NOT NULL
         ),
         identity_tree(value) AS (
           SELECT unnest($3::text[])
           UNION SELECT value FROM relevant_order_ids
           UNION
           SELECT field.graphql_id
             FROM source_shopify.shopify_fields field
             JOIN identity_tree parent ON field.parent_graphql_id=parent.value
            WHERE field.tenant_id=$1 AND field.connection_id=$2
              AND field.graphql_id IS NOT NULL
         ),
         selected_order_lines AS (
           SELECT line.* FROM source_shopify.shopify_order_lines line
            WHERE line.tenant_id=$1 AND line.connection_id=$2
              AND (line.customer_id=ANY($3::text[])
                OR line.order_id IN (SELECT value FROM relevant_order_ids))
         ),
         selected_transactions AS (
           SELECT item.* FROM source_shopify.shopify_transactions item
            WHERE item.tenant_id=$1 AND item.connection_id=$2
              AND item.order_id IN (SELECT value FROM relevant_order_ids)
         ),
         selected_refund_lines AS (
           SELECT item.* FROM source_shopify.shopify_refund_lines item
            WHERE item.tenant_id=$1 AND item.connection_id=$2
              AND item.order_id IN (SELECT value FROM relevant_order_ids)
         ),
         selected_fulfillments AS (
           SELECT item.* FROM source_shopify.shopify_fulfillments item
            WHERE item.tenant_id=$1 AND item.connection_id=$2
              AND item.order_id IN (SELECT value FROM relevant_order_ids)
         ),
         selected_returns AS (
           SELECT item.* FROM source_shopify.shopify_returns item
            WHERE item.tenant_id=$1 AND item.connection_id=$2
              AND item.order_id IN (SELECT value FROM relevant_order_ids)
         ),
         selected_metafield_values AS (
           SELECT item.* FROM source_shopify.shopify_metafield_values item
            WHERE item.tenant_id=$1 AND item.connection_id=$2
              AND item.owner_id=ANY($3::text[])
         ),
         selected_fields AS (
           SELECT field.* FROM source_shopify.shopify_fields field
            WHERE field.tenant_id=$1 AND field.connection_id=$2
              AND (field.graphql_id IN (SELECT value FROM identity_tree)
                OR field.parent_graphql_id IN (SELECT value FROM identity_tree))
         ),
         selected_source_records AS (
           SELECT record.* FROM ingestion.source_records record
            WHERE record.tenant_id=$1 AND record.connection_id=$2
              AND record.connector_key='shopify'
              AND (
                record.source_record_id=ANY($3::text[])
                OR record.source_record_id IN (SELECT value FROM relevant_order_ids)
                OR record.normalized_payload->>'id'=ANY($3::text[])
                OR record.normalized_payload->>'id' IN (SELECT value FROM relevant_order_ids)
                OR record.normalized_payload->>'legacy_resource_id'=ANY($3::text[])
                OR record.normalized_payload->>'legacy_resource_id' IN (SELECT value FROM relevant_order_ids)
                OR record.normalized_payload->>'customer_id'=ANY($3::text[])
                OR record.normalized_payload#>>'{customer,id}'=ANY($3::text[])
                OR record.normalized_payload->>'order_id' IN (SELECT value FROM relevant_order_ids)
                OR record.normalized_payload#>>'{order,id}' IN (SELECT value FROM relevant_order_ids)
              )
         ),
         collection_estimates AS (
           SELECT count(*)::bigint records,
                  coalesce(sum(octet_length(to_jsonb(item)::text)),0)::bigint bytes
             FROM selected_customers item
           UNION ALL SELECT count(*)::bigint,
                  coalesce(sum(octet_length(to_jsonb(item)::text)),0)::bigint
             FROM selected_orders item
           UNION ALL SELECT count(*)::bigint,
                  coalesce(sum(octet_length(to_jsonb(item)::text)),0)::bigint
             FROM selected_order_lines item
           UNION ALL SELECT count(*)::bigint,
                  coalesce(sum(octet_length(to_jsonb(item)::text)),0)::bigint
             FROM selected_transactions item
           UNION ALL SELECT count(*)::bigint,
                  coalesce(sum(octet_length(to_jsonb(item)::text)),0)::bigint
             FROM selected_refund_lines item
           UNION ALL SELECT count(*)::bigint,
                  coalesce(sum(octet_length(to_jsonb(item)::text)),0)::bigint
             FROM selected_fulfillments item
           UNION ALL SELECT count(*)::bigint,
                  coalesce(sum(octet_length(to_jsonb(item)::text)),0)::bigint
             FROM selected_returns item
           UNION ALL SELECT count(*)::bigint,
                  coalesce(sum(octet_length(to_jsonb(item)::text)),0)::bigint
             FROM selected_metafield_values item
           UNION ALL SELECT count(*)::bigint,
                  coalesce(sum(octet_length(to_jsonb(item)::text)),0)::bigint
             FROM selected_fields item
           UNION ALL SELECT count(*)::bigint,
                  coalesce(sum(octet_length(to_jsonb(item)::text)),0)::bigint
             FROM selected_source_records item
         )
         SELECT coalesce(sum(records),0)::text AS record_count,
                (coalesce(sum(bytes),0)+16384)::text AS estimated_bytes
           FROM collection_estimates`,
        [grant.tenant_id, grant.connection_id, customerCandidates, orderCandidates],
      );
      assertShopifyPrivacyExportBounds(
        nonnegativeBigInt(estimate.rows[0]?.record_count, "record count"),
        nonnegativeBigInt(estimate.rows[0]?.estimated_bytes, "byte size"),
      );
      const result = await client.query(
        `WITH RECURSIVE
         selected_customers AS (
           SELECT customer.*
             FROM source_shopify.shopify_customers customer
            WHERE customer.tenant_id=$1 AND customer.connection_id=$2
              AND (customer.id=ANY($3::text[])
                OR customer.legacy_resource_id=ANY($3::text[])
                OR customer.source_record_id=ANY($3::text[]))
         ),
         selected_orders AS (
           SELECT orders.*
             FROM source_shopify.shopify_orders orders
            WHERE orders.tenant_id=$1 AND orders.connection_id=$2
              AND (orders.id=ANY($4::text[])
                OR orders.legacy_resource_id=ANY($4::text[])
                OR orders.source_record_id=ANY($4::text[])
                OR orders.customer_id=ANY($3::text[]))
         ),
         relevant_order_ids(value) AS (
           SELECT unnest($4::text[])
           UNION SELECT id FROM selected_orders WHERE id IS NOT NULL
           UNION SELECT legacy_resource_id FROM selected_orders WHERE legacy_resource_id IS NOT NULL
           UNION SELECT source_record_id FROM selected_orders WHERE source_record_id IS NOT NULL
         ),
         identity_tree(value) AS (
           SELECT unnest($3::text[])
           UNION SELECT value FROM relevant_order_ids
           UNION
           SELECT field.graphql_id
             FROM source_shopify.shopify_fields field
             JOIN identity_tree parent ON field.parent_graphql_id=parent.value
            WHERE field.tenant_id=$1 AND field.connection_id=$2
              AND field.graphql_id IS NOT NULL
         ),
         selected_order_lines AS (
           SELECT line.* FROM source_shopify.shopify_order_lines line
            WHERE line.tenant_id=$1 AND line.connection_id=$2
              AND (line.customer_id=ANY($3::text[])
                OR line.order_id IN (SELECT value FROM relevant_order_ids))
         ),
         selected_transactions AS (
           SELECT item.* FROM source_shopify.shopify_transactions item
            WHERE item.tenant_id=$1 AND item.connection_id=$2
              AND item.order_id IN (SELECT value FROM relevant_order_ids)
         ),
         selected_refund_lines AS (
           SELECT item.* FROM source_shopify.shopify_refund_lines item
            WHERE item.tenant_id=$1 AND item.connection_id=$2
              AND item.order_id IN (SELECT value FROM relevant_order_ids)
         ),
         selected_fulfillments AS (
           SELECT item.* FROM source_shopify.shopify_fulfillments item
            WHERE item.tenant_id=$1 AND item.connection_id=$2
              AND item.order_id IN (SELECT value FROM relevant_order_ids)
         ),
         selected_returns AS (
           SELECT item.* FROM source_shopify.shopify_returns item
            WHERE item.tenant_id=$1 AND item.connection_id=$2
              AND item.order_id IN (SELECT value FROM relevant_order_ids)
         ),
         selected_metafield_values AS (
           SELECT item.* FROM source_shopify.shopify_metafield_values item
            WHERE item.tenant_id=$1 AND item.connection_id=$2
              AND item.owner_id=ANY($3::text[])
         ),
         selected_fields AS (
           SELECT field.* FROM source_shopify.shopify_fields field
            WHERE field.tenant_id=$1 AND field.connection_id=$2
              AND (field.graphql_id IN (SELECT value FROM identity_tree)
                OR field.parent_graphql_id IN (SELECT value FROM identity_tree))
         ),
         selected_source_records AS (
           SELECT record.* FROM ingestion.source_records record
            WHERE record.tenant_id=$1 AND record.connection_id=$2
              AND record.connector_key='shopify'
              AND (
                record.source_record_id=ANY($3::text[])
                OR record.source_record_id IN (SELECT value FROM relevant_order_ids)
                OR record.normalized_payload->>'id'=ANY($3::text[])
                OR record.normalized_payload->>'id' IN (SELECT value FROM relevant_order_ids)
                OR record.normalized_payload->>'legacy_resource_id'=ANY($3::text[])
                OR record.normalized_payload->>'legacy_resource_id' IN (SELECT value FROM relevant_order_ids)
                OR record.normalized_payload->>'customer_id'=ANY($3::text[])
                OR record.normalized_payload#>>'{customer,id}'=ANY($3::text[])
                OR record.normalized_payload->>'order_id' IN (SELECT value FROM relevant_order_ids)
                OR record.normalized_payload#>>'{order,id}' IN (SELECT value FROM relevant_order_ids)
              )
         )
         SELECT jsonb_build_array(
           jsonb_build_object('name','customers','records',coalesce((
             SELECT jsonb_agg(to_jsonb(item)-ARRAY[
               'tenant_id','connection_id','namespaced_source_key','external_account_reference',
               'payload_hash','payload_batch_id','sync_run_id','mapping_version',
               'first_ingested_at','ingested_at'
             ]::text[] ORDER BY item.source_record_id) FROM selected_customers item
           ),'[]'::jsonb)),
           jsonb_build_object('name','orders','records',coalesce((
             SELECT jsonb_agg(to_jsonb(item)-ARRAY[
               'tenant_id','connection_id','namespaced_source_key','external_account_reference',
               'payload_hash','payload_batch_id','sync_run_id','mapping_version',
               'first_ingested_at','ingested_at'
             ]::text[] ORDER BY item.source_record_id) FROM selected_orders item
           ),'[]'::jsonb)),
           jsonb_build_object('name','order_lines','records',coalesce((
             SELECT jsonb_agg(to_jsonb(item)-ARRAY[
               'tenant_id','connection_id','namespaced_source_key','external_account_reference',
               'payload_hash','payload_batch_id','sync_run_id','mapping_version',
               'first_ingested_at','ingested_at'
             ]::text[] ORDER BY item.source_record_id) FROM selected_order_lines item
           ),'[]'::jsonb)),
           jsonb_build_object('name','transactions','records',coalesce((
             SELECT jsonb_agg(to_jsonb(item)-ARRAY[
               'tenant_id','connection_id','namespaced_source_key','external_account_reference',
               'payload_hash','payload_batch_id','sync_run_id','mapping_version',
               'first_ingested_at','ingested_at'
             ]::text[] ORDER BY item.source_record_id) FROM selected_transactions item
           ),'[]'::jsonb)),
           jsonb_build_object('name','refund_lines','records',coalesce((
             SELECT jsonb_agg(to_jsonb(item)-ARRAY[
               'tenant_id','connection_id','namespaced_source_key','external_account_reference',
               'payload_hash','payload_batch_id','sync_run_id','mapping_version',
               'first_ingested_at','ingested_at'
             ]::text[] ORDER BY item.source_record_id) FROM selected_refund_lines item
           ),'[]'::jsonb)),
           jsonb_build_object('name','fulfillments','records',coalesce((
             SELECT jsonb_agg(to_jsonb(item)-ARRAY[
               'tenant_id','connection_id','namespaced_source_key','external_account_reference',
               'payload_hash','payload_batch_id','sync_run_id','mapping_version',
               'first_ingested_at','ingested_at'
             ]::text[] ORDER BY item.source_record_id) FROM selected_fulfillments item
           ),'[]'::jsonb)),
           jsonb_build_object('name','returns','records',coalesce((
             SELECT jsonb_agg(to_jsonb(item)-ARRAY[
               'tenant_id','connection_id','namespaced_source_key','external_account_reference',
               'payload_hash','payload_batch_id','sync_run_id','mapping_version',
               'first_ingested_at','ingested_at'
             ]::text[] ORDER BY item.source_record_id) FROM selected_returns item
           ),'[]'::jsonb)),
           jsonb_build_object('name','metafield_values','records',coalesce((
             SELECT jsonb_agg(to_jsonb(item)-ARRAY[
               'tenant_id','connection_id','namespaced_source_key','external_account_reference',
               'payload_hash','payload_batch_id','sync_run_id','mapping_version',
               'first_ingested_at','ingested_at'
             ]::text[] ORDER BY item.source_record_id) FROM selected_metafield_values item
           ),'[]'::jsonb)),
           jsonb_build_object('name','long_tail_fields','records',coalesce((
             SELECT jsonb_agg(to_jsonb(item)-ARRAY[
               'tenant_id','connection_id','namespaced_source_key','external_account_reference',
               'payload_hash','payload_batch_id','sync_run_id','mapping_version',
               'first_ingested_at','ingested_at'
             ]::text[] ORDER BY item.source_record_id) FROM selected_fields item
           ),'[]'::jsonb)),
           jsonb_build_object('name','normalized_source_records','records',coalesce((
             SELECT jsonb_agg(jsonb_build_object(
               'sourceObjectType',item.source_object_type,
               'sourceRecordId',item.source_record_id,
               'sourceVersion',item.source_version,
               'sourceUpdatedAt',item.source_updated_at,
               'tombstone',item.tombstone,
               'payload',item.normalized_payload
             ) ORDER BY item.source_object_type,item.source_record_id)
             FROM selected_source_records item
           ),'[]'::jsonb))
         ) AS collections`,
        [grant.tenant_id, grant.connection_id, customerCandidates, orderCandidates],
      );
      await client.query("COMMIT");
      const collections = result.rows[0]?.collections;
      if (!Array.isArray(collections)) throw new Error("Shopify privacy export returned invalid collections.");
      const recordCount = collections.reduce((total, collection) => {
        const records = collection && typeof collection === "object" &&
          Array.isArray((collection as Readonly<{ records?: unknown }>).records)
          ? (collection as Readonly<{ records: readonly unknown[] }>).records
          : null;
        if (!records) throw new Error("Shopify privacy export returned an invalid collection.");
        return total + records.length;
      }, 0);
      assertShopifyPrivacyExportBounds(BigInt(recordCount), 0n);
      const artifact = shopifyPrivacyArtifactSchema.parse({
        schemaVersion: 1,
        exportId: grant.export_id,
        caseId: grant.case_id,
        generatedAt,
        source: "albert_shopify_customer_data",
        customerReference: grant.customer_reference,
        orderReferences: grant.order_references,
        dataRequestReference: grant.data_request_reference,
        collections,
        recordCount,
      });
      const byteLength = Buffer.byteLength(JSON.stringify(artifact), "utf8");
      assertShopifyPrivacyExportBounds(BigInt(recordCount), BigInt(byteLength));
      return artifact;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep original failure */ }
      const wrapped = new Error("Shopify privacy export failed.");
      Object.assign(wrapped, { diagnosticCode: databaseErrorCode(error) });
      throw wrapped;
    } finally {
      client.release();
    }
  }

  async ready(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await this.assertRuntimeIdentity(client);
      await client.query("SET LOCAL ROLE diagnostic_ro");
      const result = await client.query(
        `SELECT current_role='diagnostic_ro'
             AND capability_internal.assert_verifier_ready()
             AND to_regclass('source_shopify.shopify_customers') IS NOT NULL
             AND to_regclass('source_shopify.shopify_orders') IS NOT NULL
             AND to_regclass('source_shopify.shopify_metafield_values') IS NOT NULL
             AND to_regclass('source_shopify.shopify_fields') IS NOT NULL
             AND to_regclass('ingestion.source_records') IS NOT NULL AS ready`,
      );
      await client.query("COMMIT");
      return result.rows[0]?.ready === true;
    } catch {
      try { await client.query("ROLLBACK"); } catch { /* readiness is false */ }
      return false;
    } finally {
      client.release();
    }
  }

  private async assertRuntimeIdentity(client: DiagnosticPgClient): Promise<void> {
    const result = await client.query(
      `SELECT session_user='albert_operator_diagnostic_analytical_runtime'
          AND pg_catalog.pg_has_role(session_user,'diagnostic_ro','member')
          AND (SELECT count(*) FROM pg_catalog.pg_auth_members membership
               JOIN pg_catalog.pg_roles member ON member.oid=membership.member
               WHERE member.rolname=session_user)=1 AS ready`,
    );
    if (result.rows[0]?.ready !== true) {
      throw new Error("Operator diagnostic analytical login has an unsafe role boundary.");
    }
  }
}
