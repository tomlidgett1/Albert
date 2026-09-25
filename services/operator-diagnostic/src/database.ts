import {
  fivetranMyDataCatalogueSchema,
  fivetranMyDataGrantSchema,
  fivetranMyDataTableSchema,
  operatorDiagnosticGrantSchema,
  operatorDiagnosticSampleSchema,
  protectedDogfoodOnboardingReceiptRequestSchema,
  protectedDogfoodOnboardingReceiptSchema,
  shopifyPrivacyArtifactSchema,
  shopifyPrivacyExportGrantSchema,
  targetMatchesStage,
  type FivetranMyDataCatalogue,
  type FivetranMyDataGrant,
  type FivetranMyDataResult,
  type FivetranMyDataTable,
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
const MY_DATA_MAX_COLUMNS = 64;
const FIVETRAN_SYSTEM_TABLE = /^(?:_?fivetran_|albert_)/u;
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

function safeNonnegativeInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(parsed));
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

  async claimFivetranMyData(requestId: string): Promise<FivetranMyDataGrant> {
    return this.inRole(async (client) => {
      const result = await client.query(
        "SELECT control_plane.claim_fivetran_my_data_request($1) AS grant",
        [requestId],
      );
      return fivetranMyDataGrantSchema.parse(result.rows[0]?.grant);
    });
  }

  async completeFivetranMyData(input: Readonly<{
    requestId: string;
    status: "completed" | "failed";
    resultCount: number;
    errorCode?: string;
  }>): Promise<void> {
    await this.inRole(async (client) => {
      await client.query(
        "SELECT control_plane.complete_fivetran_my_data_request($1,$2,$3,$4)",
        [input.requestId, input.status, input.resultCount, input.errorCode ?? null],
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
               ) IS NOT NULL
               AND to_regprocedure('control_plane.claim_fivetran_my_data_request(text)') IS NOT NULL
               AND to_regprocedure(
                 'control_plane.complete_fivetran_my_data_request(text,text,integer,text)'
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

  async browseFivetranMyData(untrustedGrant: FivetranMyDataGrant): Promise<FivetranMyDataResult> {
    const grant = fivetranMyDataGrantSchema.parse(untrustedGrant);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await this.assertRuntimeIdentity(client);
      await client.query("SET LOCAL ROLE diagnostic_ro");
      await client.query(
        "SELECT set_config('albert.tenant_capability',$1,true)",
        [grant.analytical_capability],
      );
      await client.query("SELECT set_config('statement_timeout','5000ms',true)");
      await client.query("SELECT set_config('lock_timeout','500ms',true)");
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('deletion:'||$1,0))",
        [grant.tenant_id],
      );

      const schemas = grant.sources.map((source) => source.destination_schema);
      const bindings = schemas.length === 0
        ? { rows: [] as readonly Row[] }
        : await client.query(
          `SELECT destination_schema,connection_id
             FROM ingestion.fivetran_destination_bindings
            WHERE tenant_id=$1 AND destination_schema=ANY($2::text[])
            ORDER BY destination_schema`,
          [grant.tenant_id, schemas],
        );
      const expectedBindings = grant.sources
        .map((source) => `${source.destination_schema}\u0000${source.connection_id}`)
        .sort();
      const actualBindings = bindings.rows
        .map((row) => `${String(row.destination_schema ?? "")}\u0000${String(row.connection_id ?? "")}`)
        .sort();
      if (actualBindings.length !== expectedBindings.length ||
          actualBindings.some((value, index) => value !== expectedBindings[index])) {
        throw diagnosticFailure(
          "FIVETRAN_MY_DATA_BINDING_MISMATCH",
          "Fivetran destination binding does not match the control-plane grant.",
        );
      }

      const result = grant.request_kind === "catalogue"
        ? await this.fivetranCatalogue(client, grant)
        : await this.fivetranRows(client, grant);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep original failure */ }
      const wrapped = new Error("Fivetran My Data read failed.");
      Object.assign(wrapped, { diagnosticCode: databaseErrorCode(error) });
      throw wrapped;
    } finally {
      client.release();
    }
  }

  private async fivetranCatalogue(
    client: DiagnosticPgClient,
    grant: FivetranMyDataGrant,
  ): Promise<Readonly<{ kind: "catalogue"; catalogue: FivetranMyDataCatalogue }>> {
    const schemas = grant.sources.map((source) => source.destination_schema);
    const metadata = schemas.length === 0
      ? { rows: [] as readonly Row[] }
      : await client.query(
        `SELECT namespace.nspname AS schema_name,
                class.relname AS table_name,
                coalesce(stat.n_live_tup,0)::text AS approximate_rows,
                count(attribute.attnum) FILTER (
                  WHERE attribute.attnum>0 AND NOT attribute.attisdropped
                )::integer AS column_count,
                bool_or(attribute.attname='tenant_id' AND NOT attribute.attisdropped) AS tenant_scoped,
                class.relrowsecurity AS row_security,
                pg_catalog.has_schema_privilege('diagnostic_ro',namespace.oid,'USAGE') AS schema_readable,
                pg_catalog.has_table_privilege('diagnostic_ro',class.oid,'SELECT') AS table_readable
           FROM pg_catalog.pg_namespace AS namespace
           JOIN pg_catalog.pg_class AS class ON class.relnamespace=namespace.oid
           LEFT JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid=class.oid
           LEFT JOIN pg_catalog.pg_stat_all_tables AS stat ON stat.relid=class.oid
          WHERE namespace.nspname=ANY($1::text[])
            AND class.relkind IN ('r','p')
            AND class.relname !~ '^(fivetran_|_fivetran_|albert_)'
          GROUP BY namespace.nspname,class.oid,class.relname,class.relrowsecurity,
                   stat.n_live_tup,namespace.oid
          ORDER BY namespace.nspname,class.relname
          LIMIT 1000`,
        [schemas],
      );
    const tablesBySchema = new Map<string, Array<{
      name: string;
      approximateRows: number;
      columnCount: number;
      available: boolean;
    }>>();
    for (const row of metadata.rows) {
      const schemaName = String(row.schema_name ?? "");
      const tableName = String(row.table_name ?? "");
      if (!schemas.includes(schemaName) || !SAFE_IDENTIFIER.test(tableName) ||
          FIVETRAN_SYSTEM_TABLE.test(tableName)) continue;
      const tables = tablesBySchema.get(schemaName) ?? [];
      tables.push({
        name: tableName,
        approximateRows: safeNonnegativeInteger(row.approximate_rows),
        columnCount: safeNonnegativeInteger(row.column_count),
        available: row.tenant_scoped === true && row.row_security === true &&
          row.schema_readable === true && row.table_readable === true,
      });
      tablesBySchema.set(schemaName, tables);
    }
    const sources = grant.sources.map((source) => ({
      connectionId: source.connection_id,
      schemaName: source.destination_schema,
      service: source.service,
      displayName: source.display_name,
      status: source.status,
      lastSyncState: source.last_sync_state,
      updatedAt: source.updated_at,
      tables: tablesBySchema.get(source.destination_schema) ?? [],
    }));
    return {
      kind: "catalogue",
      catalogue: fivetranMyDataCatalogueSchema.parse({
        requestId: grant.request_id,
        checkedAt: new Date().toISOString(),
        totalRows: Math.min(Number.MAX_SAFE_INTEGER, sources.reduce(
          (total, source) => total + source.tables.reduce(
            (sourceTotal, table) => sourceTotal + table.approximateRows,
            0,
          ),
          0,
        )),
        sources,
      }),
    };
  }

  private async fivetranRows(
    client: DiagnosticPgClient,
    grant: FivetranMyDataGrant,
  ): Promise<Readonly<{ kind: "rows"; table: FivetranMyDataTable }>> {
    const schema = grant.schema_name;
    const table = grant.table_name;
    if (!schema || !table || FIVETRAN_SYSTEM_TABLE.test(table)) {
      throw diagnosticFailure("FIVETRAN_MY_DATA_TARGET_INVALID", "Fivetran table target is invalid.");
    }
    const schemaName = identifier(schema);
    const tableName = identifier(table);
    const target = await client.query(
      `SELECT class.relrowsecurity AS row_security,
              pg_catalog.has_schema_privilege('diagnostic_ro',namespace.oid,'USAGE') AS schema_readable,
              pg_catalog.has_table_privilege('diagnostic_ro',class.oid,'SELECT') AS table_readable,
              coalesce(stat.n_live_tup,0)::text AS approximate_rows
         FROM pg_catalog.pg_namespace AS namespace
         JOIN pg_catalog.pg_class AS class ON class.relnamespace=namespace.oid
         LEFT JOIN pg_catalog.pg_stat_all_tables AS stat ON stat.relid=class.oid
        WHERE namespace.nspname=$1 AND class.relname=$2 AND class.relkind IN ('r','p')`,
      [schema, table],
    );
    const targetRow = target.rows[0];
    if (!targetRow || targetRow.row_security !== true || targetRow.schema_readable !== true ||
        targetRow.table_readable !== true) {
      throw diagnosticFailure(
        "FIVETRAN_MY_DATA_TABLE_NOT_READY",
        "Fivetran table has not completed its tenant-safety stamp.",
      );
    }

    const metadata = await client.query(
      `SELECT column_name,data_type
         FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2
        ORDER BY ordinal_position`,
      [schema, table],
    );
    if (!metadata.rows.some((row) => row.column_name === "tenant_id")) {
      throw diagnosticFailure(
        "FIVETRAN_MY_DATA_TENANT_COLUMN_MISSING",
        "Fivetran table is not tenant scoped.",
      );
    }
    const candidates = metadata.rows.filter((row) => {
      const column = typeof row.column_name === "string" ? row.column_name : "";
      const dataType = typeof row.data_type === "string" ? row.data_type : "";
      return column !== "tenant_id" && SAFE_IDENTIFIER.test(column) &&
        !SENSITIVE_COLUMN.test(column) && !EXCLUDED_TYPES.has(dataType);
    });
    const selected = candidates.slice(0, MY_DATA_MAX_COLUMNS).map((row) => ({
      name: String(row.column_name),
      dataType: String(row.data_type),
    }));
    if (selected.length === 0) {
      throw diagnosticFailure(
        "FIVETRAN_MY_DATA_NO_SAFE_COLUMNS",
        "Fivetran table has no browse-safe scalar columns.",
      );
    }
    const projection = selected.map(({ name }) => {
      const quoted = identifier(name);
      return `CASE WHEN ${quoted} IS NULL THEN NULL ELSE left(${quoted}::text,${CELL_CHARACTER_LIMIT}) END AS ${quoted}`;
    }).join(",");
    const selectedNames = new Set(selected.map(({ name }) => name));
    const preferredOrder = ["_fivetran_synced", "updated_at", "modified_at", "created_at", "id"]
      .find((column) => selectedNames.has(column)) ?? selected[0]!.name;
    const primaryKey = await client.query(
      `SELECT attribute.attname AS column_name
         FROM pg_catalog.pg_namespace AS namespace
         JOIN pg_catalog.pg_class AS class ON class.relnamespace=namespace.oid
         JOIN pg_catalog.pg_index AS index ON index.indrelid=class.oid AND index.indisprimary
         JOIN LATERAL unnest(index.indkey) WITH ORDINALITY AS key(attnum,position) ON true
         JOIN pg_catalog.pg_attribute AS attribute
           ON attribute.attrelid=class.oid AND attribute.attnum=key.attnum
        WHERE namespace.nspname=$1 AND class.relname=$2
        ORDER BY key.position`,
      [schema, table],
    );
    const primaryOrder = primaryKey.rows
      .map((row) => String(row.column_name ?? ""))
      .filter((column) => SAFE_IDENTIFIER.test(column));
    const orderColumns = primaryOrder.length > 0 ? primaryOrder : [preferredOrder];
    const orderDirection = primaryOrder.length > 0 || preferredOrder === "id" ||
      preferredOrder === selected[0]!.name ? "ASC" : "DESC";
    const orderSql = orderColumns
      .map((column) => `${identifier(column)} ${orderDirection} NULLS LAST`)
      .join(",");
    const page = await client.query(
      `SELECT ${projection}
         FROM ${schemaName}.${tableName}
        WHERE tenant_id=$1
        ORDER BY ${orderSql}
        LIMIT $2 OFFSET $3`,
      [grant.tenant_id, grant.row_limit + 1, grant.row_offset],
    );
    const hasMore = page.rows.length > grant.row_limit;
    const visibleRows = page.rows.slice(0, grant.row_limit).map((row) =>
      Object.fromEntries(selected.map(({ name }) => {
        const value = row[name];
        return [name, value === null || value === undefined ? null : String(value)];
      })),
    );
    return {
      kind: "rows",
      table: fivetranMyDataTableSchema.parse({
        requestId: grant.request_id,
        schemaName: schema,
        tableName: table,
        columns: selected,
        rows: visibleRows,
        offset: grant.row_offset,
        limit: grant.row_limit,
        hasMore,
        approximateRows: safeNonnegativeInteger(targetRow.approximate_rows),
        excludedColumnCount: metadata.rows.length - 1 - candidates.length,
        additionalColumnCount: Math.max(0, candidates.length - selected.length),
        cellCharacterLimit: CELL_CHARACTER_LIMIT,
      }),
    };
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
    let client: DiagnosticPgClient;
    try {
      client = await this.pool.connect();
    } catch {
      return false;
    }
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await this.assertRuntimeIdentity(client);
      await client.query("SET LOCAL ROLE diagnostic_ro");
      const result = await client.query(
        `SELECT current_role='diagnostic_ro'
             AND capability_internal.assert_verifier_ready()
             AND to_regclass('ingestion.fivetran_destination_bindings') IS NOT NULL
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
