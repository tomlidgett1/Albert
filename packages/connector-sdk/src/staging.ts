import type { ConnectorId, SourceRecordProjection } from "./index.js";
import type { ConnectorManifest, FieldCoverage, StagingFieldType } from "./contract.js";
import { normalizeDecimal, normalizeTimestamp } from "./normalization.js";

export type StagingFieldContract = Readonly<{
  sourceField: string;
  column: string;
  type: StagingFieldType;
  disposition: FieldCoverage["disposition"];
  pii: FieldCoverage["pii"];
}>;

export type StagingStreamContract = Readonly<{
  connectorId: ConnectorId;
  schema: "source_lightspeed" | "source_lightspeed_x" | "source_xero" | "source_deputy" | "source_square" | "source_shopify" | "source_momence";
  stream: string;
  table: string;
  reprocessIdenticalPayloadOnNewBatch: boolean;
  fields: readonly StagingFieldContract[];
}>;

export type StagingProjectionIssue = Readonly<{
  code: "normalization_invalid" | "schema_drift";
  path: string;
  message: string;
}>;

export type StagingProjectionResult = Readonly<{
  values: Readonly<Record<string, unknown>>;
  issues: readonly StagingProjectionIssue[];
}>;

/**
 * A publication-safe description of one source-native field. These records are
 * built exclusively from reviewed connector manifests; they never contain
 * tenant data or values observed in a source system.
 */
export type GovernedSourceCatalogueField = Readonly<{
  connectorId: ConnectorId;
  connectorLabel: string;
  packVersion: string;
  stream: string;
  sourceTable: string;
  sourceField: string;
  sourceColumn: string;
  queryPath: string | null;
  target: string;
  stagingType: StagingFieldType;
  pii: FieldCoverage["pii"];
  queryable: boolean;
  vendorAliases: readonly string[];
}>;

/** Columns owned by the immutable tenant/source lineage envelope, not by a
 * connector's payload projection. A manifest may name them for governance,
 * but the table renderer must never emit a duplicate physical column. */
const STAGING_PLATFORM_COLUMNS: ReadonlySet<string> = new Set([
  "tenant_id",
  "namespaced_source_key",
  "connection_id",
  "external_account_reference",
  "source_record_id",
  "source_version",
  "source_updated_at",
  "payload_hash",
  "payload_batch_id",
  "sync_run_id",
  "tombstone",
  "mapping_version",
  "first_ingested_at",
  "ingested_at",
]);

// Partial by design: authorization-only packs stage no field, so requiring an
// empty entry per connector would be ceremony that silently rots.
const moneyFields: Readonly<Partial<Record<ConnectorId, ReadonlySet<string>>>> = {
  "lightspeed-r": new Set([
    "defaultCost", "avgCost", "qoh", "sellable", "backorder", "componentQoh",
    "componentBackorder", "reorderPoint", "reorderLevel", "onLayaway", "onSpecialOrder",
    "onWorkOrder", "onWorkorder", "onTransferOut", "onTransferIn", "averageCost",
    "totalValueFifo", "totalValueAvgCost", "totalValueNegativeInventory", "lastReceivedCost",
    "nextFifoLotCost", "total", "taxTotal", "calcDiscount", "calcTotal", "calcSubtotal",
    "calcTaxable", "calcNonTaxable", "calcAvgCost", "calcFIFOCost", "calcTax1", "calcTax2",
    "calcPayments", "calcTips", "totalDue", "displayableTotal", "balance", "cashRoundingDelta",
    "cashRoundedBalance", "cashRoundedTotal", "shipCost", "shipVendorCost", "otherCost",
    "otherVendorCost", "totalDiscount", "subTotalCost", "totalCost", "discountMoneyValue",
    "discountMoneyVendorValue", "quantity", "price", "originalPrice", "vendorCost", "checkedIn",
    "numReceived", "shippingCost", "shippingVendorCost", "tax1Rate", "tax2Rate", "qohChange",
    "costChange", "unitQuantity", "unitPrice", "normalUnitPrice", "discountAmount",
    "amount", "serviceRate", "leftNode", "rightNode", "discountPercent", "change",
    "displayableSubtotal", "calcSurcharges", "calcItemFees", "tippableAmount", "discount",
    "totalQuantity", "vendorCurrencyRate", "discountPercentValue",
  ]),
  xero: new Set([
    "SubTotal", "TotalTax", "Total", "AmountDue", "AmountPaid", "RemainingCredit",
    "Amount", "BankAmount", "CurrencyRate", "DisplayTaxRate", "EffectiveRate", "FinancialYearEndDay",
    "FinancialYearEndMonth",
  ]),
  deputy: new Set(["TotalTime", "Cost", "OnCost", "Days", "TotalHours", "Mealbreak"]),
};

const dateFields = new Set([
  "Date", "DueDate", "FullyPaidOnDate", "JournalDate", "StartDate", "TerminationDate",
  "DateStart", "DateEnd",
]);

const timestampFields = new Set([
  "timeStamp", "updatetime", "updateTime", "createTime", "completeTime", "orderedDate",
  "receivedDate", "arrivalDate", "UpdatedDateUTC", "UpdatedDateUTCString", "CreatedDateUTC",
  "Modified", "Created", "StartTime", "EndTime", "StartTimeLocalized", "EndTimeLocalized",
  "DateString", "Start", "End",
]);

const jsonFields: Readonly<Partial<Record<ConnectorId, ReadonlySet<string>>>> = {
  "lightspeed-r": new Set([
    "Contact", "SaleLines", "SalePayments", "OrderLines", "Parent", "Category", "TaxClass",
    "Department", "ItemAttributes", "Manufacturer", "Note", "Season", "ItemShops",
    "ItemComponents", "ItemShelfLocations", "ItemVendorNums", "CustomFieldValues", "Prices",
    "Customer", "Discount", "Quote", "ShipTo", "TaxCategory", "Vendor", "Shop",
    "TaxCategoryClasses", "Reps", "purchasingCurrency",
  ]),
  xero: new Set([
    "Contact", "LineItems", "Invoice", "CreditNote", "Account", "BankAccount",
    "JournalLines", "TaxComponents", "Options", "Allocations", "Addresses", "Phones",
    "BatchPayment", "Prepayment", "Overpayment",
  ]),
  deputy: new Set(["Slots", "MealbreakSlots", "NotifyManagerArray", "LeavePayLineArray"]),
};

const booleanFields = new Set([
  "active", "Active", "archived", "completed", "voided", "lockOut", "Published", "Open",
  "TimeApproved", "Discarded", "IsLeave", "PayRuleApproved", "Exported",
  "IsReconciled", "HasAttachments", "ShowOnCashBasisReports", "CanApplyToAssets",
  "HasAccount", "HasValidationErrors", "AllDay", "DateStartAllDay", "DateEndAllDay",
  "CanApplyToEquity", "CanApplyToExpenses", "CanApplyToLiabilities", "CanApplyToRevenue",
  "IsWorkplace", "IsPayrollEntity", "ShowOnRoster", "PrimaryEmail", "PrimaryPhone",
  "taxLabor", "labelMsrp", "zebraBrowserPrint", "discountable", "serialized", "publishToEcom",
  "enablePromotions", "isTaxInclusive", "tipEnabled", "complete", "hasShipments",
  "discountIsPercent", "costsModifiedAfterShipment", "requireCustomer", "internalReserved",
  "automated", "causedNegative", "EnablePaymentsToAccount", "updatePrice", "updateCost",
  "updateDescription", "shareSellThrough",
  // Item.tax / SaleLine.tax are taxable flags in current R-Series payloads, not money.
  "tax",
]);

const numericFields = new Set(["JournalNumber", "nodeDepth", "RosterSortOrder"]);

export function inferStagingType(
  connectorId: ConnectorId,
  field: string,
  target?: string,
): StagingFieldType {
  if (moneyFields[connectorId]?.has(field)) return "numeric";
  if (dateFields.has(field) || /(?:\.business_date|\.valid_from|\.valid_to)$/u.test(target ?? "")) return "date";
  if (timestampFields.has(field) || /(?:_at)$/u.test(target ?? "")) return "timestamptz";
  if (jsonFields[connectorId]?.has(field) || /(?:observations|source_options|components)$/u.test(target ?? "")) return "jsonb";
  if (booleanFields.has(field) || /\.(?:active|voided|approved|discarded|published|is_[a-z_]+)$/u.test(target ?? "")) return "boolean";
  if (numericFields.has(field)) return "numeric";
  return "text";
}

export function stagingSchema(connectorId: ConnectorId): StagingStreamContract["schema"] {
  if (connectorId === "lightspeed-r") return "source_lightspeed";
  if (connectorId === "lightspeed-x") return "source_lightspeed_x";
  if (connectorId === "xero") return "source_xero";
  if (connectorId === "deputy") return "source_deputy";
  if (connectorId === "square") return "source_square";
  if (connectorId === "shopify") return "source_shopify";
  if (connectorId === "momence") return "source_momence";
  // Authorization-only packs own no staging schema. Failing closed keeps a
  // future stream from silently projecting into another connector's schema,
  // which a trailing `return "source_deputy"` would have done.
  throw new Error(`${connectorId} declares no staging schema.`);
}

export function stagingColumnName(sourceField: string): string {
  const value = sourceField
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) {
    throw new Error(`Source field ${sourceField} cannot become a safe staging column.`);
  }
  return value;
}

export function buildStagingContracts(
  manifests: readonly ConnectorManifest[],
): readonly StagingStreamContract[] {
  return manifests.flatMap((manifest) => manifest.streams.map((stream) => {
    const entries = manifest.fieldCoverage.filter(
      (entry) => entry.stream === stream.id && entry.disposition !== "unsupported",
    );
    if (entries.length === 0) throw new Error(`${manifest.id}.${stream.id} has no field coverage.`);
    const physical = new Map<string, StagingFieldContract>();
    for (const entry of entries) {
      const sourceField = entry.storageField ?? entry.field;
      const candidate: StagingFieldContract = {
        sourceField,
        column: stagingColumnName(sourceField),
        type: entry.storageType ?? entry.stagingType,
        disposition: entry.disposition,
        pii: entry.pii,
      };
      // Connector catalogues may reference the platform envelope explicitly
      // for governed lineage and primary-key semantics. Those columns are
      // rendered once by renderTable and must never be duplicated as payload
      // projection columns.
      if (STAGING_PLATFORM_COLUMNS.has(candidate.column)) continue;
      const existing = physical.get(sourceField);
      if (existing) {
        if (existing.column !== candidate.column || existing.type !== candidate.type) {
          throw new Error(`${manifest.id}.${stream.id} has incompatible shared storage ${sourceField}.`);
        }
        continue;
      }
      physical.set(sourceField, candidate);
    }
    const fields = [...physical.values()];
    const columns = new Set<string>();
    for (const field of fields) {
      if (columns.has(field.column)) {
        throw new Error(`${manifest.id}.${stream.id} staging column collision at ${field.column}.`);
      }
      columns.add(field.column);
    }
    return {
      connectorId: manifest.id,
      schema: stagingSchema(manifest.id),
      stream: stream.id,
      table: stagingColumnName(stream.id),
      reprocessIdenticalPayloadOnNewBatch: stream.reprocessIdenticalPayloadOnNewBatch === true,
      fields,
    };
  }));
}

export function buildGovernedSourceCatalogueFields(
  manifests: readonly ConnectorManifest[],
): readonly GovernedSourceCatalogueField[] {
  const fields = manifests.flatMap((manifest) => {
    const governedEntries = manifest.fieldCoverage.filter(
      (entry) => entry.disposition === "governed_extension",
    );
    const aliasesByIdentity = new Map<string, string[]>();
    for (const entry of governedEntries) {
      const identity = `${entry.stream}\u0000${normalizedVendorField(entry.field)}`;
      const aliases = aliasesByIdentity.get(identity);
      if (aliases) aliases.push(entry.field);
      else aliasesByIdentity.set(identity, [entry.field]);
    }
    for (const aliases of aliasesByIdentity.values()) aliases.sort();

    return governedEntries.map((entry) => {
      const sourceColumn = stagingColumnName(entry.storageField ?? entry.field);
      const identity = `${entry.stream}\u0000${normalizedVendorField(entry.field)}`;
      const peers = aliasesByIdentity.get(identity) ?? [];
      return Object.freeze({
        connectorId: manifest.id,
        connectorLabel: manifest.displayName,
        packVersion: manifest.packVersion,
        stream: entry.stream,
        sourceTable: stagingColumnName(entry.stream),
        sourceField: entry.field,
        sourceColumn,
        queryPath: entry.queryPath ?? null,
        target: entry.target ?? `${stagingSchema(manifest.id)}.${stagingColumnName(entry.stream)}.${sourceColumn}`,
        stagingType: entry.stagingType,
        pii: entry.pii,
        queryable: entry.queryable ?? (entry.storageField !== undefined || entry.stagingType !== "jsonb"),
        vendorAliases: Object.freeze(peers.filter((field) => field !== entry.field)),
      });
    });
  });
  const ids = new Set<string>();
  for (const field of fields) {
    const id = `${field.connectorId}:${field.sourceTable}:${field.sourceField}`;
    if (ids.has(id)) throw new Error(`Duplicate governed source catalogue field ${id}.`);
    ids.add(id);
  }
  return Object.freeze(fields.sort((left,right) =>
    `${left.connectorId}:${left.sourceTable}:${left.sourceColumn}`.localeCompare(
      `${right.connectorId}:${right.sourceTable}:${right.sourceColumn}`,
    )));
}

export function projectStagingFields(
  contract: StagingStreamContract,
  projection: SourceRecordProjection,
): StagingProjectionResult {
  const allowed = new Set(contract.fields.map((field) => field.sourceField));
  const issues: StagingProjectionIssue[] = [];
  for (const field of Object.keys(projection.fields)) {
    if (!allowed.has(field)) {
      issues.push({
        code: "schema_drift",
        path: field,
        message: "The normalized projection contains a field without a staging contract.",
      });
    }
  }

  const values: Record<string, unknown> = {};
  for (const field of contract.fields) {
    const raw = projection.fields[field.sourceField];
    const converted = convertField(field, raw, projection);
    if (converted.issue) issues.push(converted.issue);
    values[field.column] = converted.value;
  }
  return { values, issues };
}

function convertField(
  field: StagingFieldContract,
  raw: unknown,
  projection: SourceRecordProjection,
): Readonly<{
  value: unknown;
  issue?: StagingProjectionIssue;
}> {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  if (field.type === "jsonb") {
    if (typeof raw !== "object") return invalid(field, "Expected an object or array compatible with jsonb.");
    try {
      const encoded = JSON.stringify(raw);
      return encoded === undefined
        ? invalid(field, "Expected a JSON-compatible object or array.")
        : { value: JSON.parse(encoded) as unknown };
    } catch {
      return invalid(field, "Expected a JSON-compatible object or array.");
    }
  }
  if (field.type === "numeric") {
    const exact = projection.money?.[field.sourceField]?.exact ?? normalizeDecimal(raw).exact;
    const coerced = exact === null ? null : coerceNumeric19_4(exact);
    return coerced === null
      ? invalid(field, "Expected an exact decimal compatible with numeric(19,4).")
      : { value: coerced };
  }
  if (field.type === "date") {
    const normalized = normalizeDate(raw);
    return normalized === null
      ? invalid(field, "Expected a valid ISO calendar date.")
      : { value: normalized };
  }
  if (field.type === "timestamptz") {
    const normalized = projection.timestamps?.[field.sourceField]?.utc ?? normalizeTimestamp(
      raw,
      field.sourceField === "StartTime" || field.sourceField === "EndTime"
        || field.sourceField === "Start" || field.sourceField === "End"
        ? { unixUnit: "seconds" }
        : {},
    ).utc;
    return normalized === null
      ? invalid(field, "Expected a valid source timestamp.")
      : { value: normalized };
  }
  if (field.type === "boolean") {
    const normalized = normalizeBoolean(raw);
    return normalized === null
      ? invalid(field, "Expected a boolean-compatible source value.")
      : { value: normalized };
  }
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return { value: String(raw) };
  }
  return invalid(field, "Expected a scalar text-compatible source value.");
}

function normalizedVendorField(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

function invalid(
  field: StagingFieldContract,
  message: string,
): Readonly<{ value: null; issue: StagingProjectionIssue }> {
  return {
    value: null,
    issue: { code: "normalization_invalid", path: field.sourceField, message },
  };
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "active", "approved", "published"].includes(normalized)) return true;
  if (["false", "no", "n", "inactive", "archived", "deleted"].includes(normalized)) return false;
  return null;
}

function fitsNumeric19_4(value: string): boolean {
  const match = /^-?(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) return false;
  const integerDigits = match[1].replace(/^0+(?=\d)/u, "").length;
  return integerDigits <= 15 && (match[2]?.length ?? 0) <= 4;
}

/**
 * Coerce a base-10 decimal into numeric(19,4).
 * Values with more than 4 fractional digits are half-up rounded so Lightspeed
 * averages (avgCost etc.) can land without quarantine while staying in-column.
 */
function coerceNumeric19_4(value: string): string | null {
  if (fitsNumeric19_4(value)) return value;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) return null;
  const sign = match[1] ?? "";
  const integerRaw = match[2] ?? "0";
  const fractionRaw = match[3] ?? "";
  if (fractionRaw.length <= 4) return null;

  const integerDigits = integerRaw.replace(/^0+(?=\d)/u, "");
  if (integerDigits.length > 15) return null;

  const keep = fractionRaw.slice(0, 4);
  const nextDigit = fractionRaw.charAt(4);
  let fraction = BigInt(keep || "0");
  let integer = BigInt(integerRaw);
  if (nextDigit >= "5") fraction += 1n;
  if (fraction === 10000n) {
    integer += 1n;
    fraction = 0n;
  }
  if (integer.toString().replace(/^-/u, "").length > 15) return null;

  const fractionText = fraction.toString().padStart(4, "0").replace(/0+$/u, "");
  const integerText = integer.toString();
  return fractionText.length === 0
    ? `${sign}${integerText}`
    : `${sign}${integerText}.${fractionText}`;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/u.exec(value.trim());
    if (match) {
      return isCalendarDate(match[1], match[2], match[3])
        ? `${match[1]}-${match[2]}-${match[3]}`
        : null;
    }
  }
  const utc = normalizeTimestamp(value).utc;
  return utc?.slice(0, 10) ?? null;
}

function isCalendarDate(yearText: string, monthText: string, dayText: string): boolean {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function renderTypedStagingMigration(
  manifests: readonly ConnectorManifest[],
): string {
  const contracts = buildStagingContracts(manifests);
  const sql = [
    "BEGIN;",
    "",
    "-- Generated from connector manifests. Do not hand-edit field columns.",
    "-- Exact raw payloads remain in immutable object storage; these tables hold only typed projections.",
    "",
  ];
  for (const source of [
    ["source_lightspeed_x", "Lightspeed X-Series"],
    ["source_square", "Square"],
    ["source_shopify", "Shopify"],
    ["source_momence", "Momence"],
  ] as const) {
    if (!contracts.some((contract) => contract.schema === source[0])) continue;
    sql.push(
      `CREATE SCHEMA IF NOT EXISTS ${source[0]};`,
      `COMMENT ON SCHEMA ${source[0]} IS 'Typed ${source[1]} staging and governed native-field projections.';`,
      `REVOKE ALL ON SCHEMA ${source[0]} FROM PUBLIC;`,
      `GRANT USAGE ON SCHEMA ${source[0]} TO ingest_rw, transform_rw, diagnostic_ro, semantic_ro;`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA ${source[0]} GRANT SELECT, INSERT, UPDATE ON TABLES TO ingest_rw;`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA ${source[0]} GRANT SELECT ON TABLES TO transform_rw, diagnostic_ro, semantic_ro;`,
      "",
    );
  }
  for (const contract of contracts) {
    sql.push(renderTable(contract), "");
  }
  const squareContracts = contracts.filter((contract) => contract.schema === "source_square");
  if (squareContracts.length > 1) {
    sql.push(renderSquareSourceFieldsView(squareContracts, manifests), "");
  }
  const lightspeedXContracts = contracts.filter(
    (contract) => contract.schema === "source_lightspeed_x",
  );
  if (lightspeedXContracts.length > 0) {
    sql.push(
      renderLightspeedXSourceFieldsView(lightspeedXContracts, manifests),
      "",
    );
  }
  for (const schema of [...new Set(contracts.map((contract) => contract.schema))].sort()) {
    sql.push(
      `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ${quoteIdentifier(schema)} TO ingest_rw;`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdentifier(schema)} TO transform_rw, diagnostic_ro, semantic_ro;`,
    );
  }
  sql.push("", "COMMIT;", "");
  return sql.join("\n");
}

/**
 * Expand X-Series' lossless field index into one stable semantic relation.
 *
 * Unlike Square, X-Series money values are already major-unit decimals, so
 * this view intentionally exposes the documented scalar value without a
 * minor-unit/currency pairing heuristic. Tenant isolation is inherited from
 * each RLS-protected parent table through security_invoker.
 */
function renderLightspeedXSourceFieldsView(
  contracts: readonly StagingStreamContract[],
  manifests: readonly ConnectorManifest[],
): string {
  const resources = new Map(
    manifests.flatMap((manifest) =>
      manifest.streams.map((stream) => [stream.id, stream.resource] as const),
    ),
  );
  const selects = contracts.map((contract) => {
    const table = `${quoteIdentifier(contract.schema)}.${quoteIdentifier(contract.table)}`;
    const stream = sqlLiteral(contract.stream);
    const resource = sqlLiteral(resources.get(contract.stream) ?? contract.stream);
    return [
      "SELECT",
      "  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,",
      "  parent.tenant_id,",
      "  parent.connection_id,",
      "  parent.external_account_reference,",
      `  ${stream}::text AS parent_stream,`,
      `  ${resource}::text AS source_object_type,`,
      "  parent.source_record_id,",
      "  parent.source_version,",
      "  parent.source_updated_at,",
      "  parent.payload_hash,",
      "  parent.payload_batch_id,",
      "  parent.sync_run_id,",
      "  parent.tombstone,",
      "  parent.mapping_version,",
      "  parent.first_ingested_at,",
      "  parent.ingested_at,",
      "  field.item ->> 'path' AS field_path,",
      "  field.item ->> 'pointer' AS field_ordinal_path,",
      "  regexp_replace(field.item ->> 'path', '^.*(?:\\.|\\[)', '') AS field_name,",
      "  field.item ->> 'kind' AS value_type,",
      "  field.item ->> 'textValue' AS string_value,",
      "  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,",
      "  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,",
      "  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,",
      "  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,",
      "  field.item -> 'rawValue' AS json_value",
      `FROM ${table} AS parent`,
      "CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)",
    ].join("\n");
  });
  return [
    "CREATE OR REPLACE VIEW source_lightspeed_x.lx_source_fields",
    "WITH (security_invoker = true)",
    "AS",
    selects.join("\nUNION ALL\n"),
    ";",
    "COMMENT ON VIEW source_lightspeed_x.lx_source_fields IS 'One tenant-safe row per lossless Lightspeed X-Series source-field occurrence; exhaustive fallback for curated semantic coverage.';",
    "GRANT SELECT ON source_lightspeed_x.lx_source_fields TO transform_rw, diagnostic_ro, semantic_ro;",
  ].join("\n");
}

/**
 * Expand Square's typed field_index into the stable long-form relation used by
 * CubeCore's exhaustive field explorer. The underlying RLS policies remain
 * authoritative because security_invoker executes with the semantic caller's
 * tenant capability rather than the migration owner's privileges.
 */
function renderSquareSourceFieldsView(
  contracts: readonly StagingStreamContract[],
  manifests: readonly ConnectorManifest[],
): string {
  const resources = new Map(manifests.flatMap((manifest) => manifest.streams.map((stream) => [
    stream.id,
    stream.resource,
  ] as const)));
  const selects = contracts.map((contract) => {
    const table = `${quoteIdentifier(contract.schema)}.${quoteIdentifier(contract.table)}`;
    const stream = sqlLiteral(contract.stream);
    const resource = sqlLiteral(resources.get(contract.stream) ?? contract.stream);
    return [
      "SELECT",
      "  parent.tenant_id,",
      "  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,",
      "  parent.connection_id,",
      "  parent.external_account_reference,",
      `  ${stream}::text AS parent_stream,`,
      `  ${resource}::text AS source_object_type,`,
      "  parent.source_record_id,",
      "  parent.source_version,",
      "  parent.source_updated_at,",
      "  parent.payload_hash,",
      "  parent.payload_batch_id,",
      "  parent.sync_run_id,",
      "  parent.tombstone,",
      "  parent.mapping_version,",
      "  parent.first_ingested_at,",
      "  parent.ingested_at,",
      "  field.item ->> 'path' AS field_path,",
      "  field.item ->> 'pointer' AS field_ordinal_path,",
      "  regexp_replace(field.item ->> 'path', '^.*\\.', '') AS field_name,",
      "  field.item ->> 'kind' AS value_type,",
      "  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,",
      "  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,",
      "  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,",
      "  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,",
      "  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,",
      "  field.item -> 'rawValue' AS json_value,",
      "  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,",
      "  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency",
      `FROM ${table} AS parent`,
      "CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)",
      "LEFT JOIN LATERAL (",
      "  SELECT candidate.item ->> 'textValue' AS currency",
      "  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)",
      "  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')",
      "  LIMIT 1",
      ") AS money ON field.item ->> 'pointer' ~ '/amount$'",
    ].join("\n");
  });
  return [
    "CREATE OR REPLACE VIEW source_square.sq_source_fields",
    "WITH (security_invoker = true)",
    "AS",
    selects.join("\nUNION ALL\n"),
    ";",
    "COMMENT ON VIEW source_square.sq_source_fields IS 'One tenant-safe row per typed Square source-field occurrence; exhaustive fallback for curated semantic coverage.';",
    "GRANT SELECT ON source_square.sq_source_fields TO transform_rw, diagnostic_ro, semantic_ro;",
  ].join("\n");
}

function renderTable(contract: StagingStreamContract): string {
  const qualified = `${quoteIdentifier(contract.schema)}.${quoteIdentifier(contract.table)}`;
  const columns = contract.fields.map((field) =>
    `  ${quoteIdentifier(field.column)} ${sqlType(field.type)}`,
  );
  return [
    `CREATE TABLE IF NOT EXISTS ${qualified} (`,
    "  tenant_id text NOT NULL,",
    "  namespaced_source_key text NOT NULL,",
    "  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),",
    "  external_account_reference text NOT NULL,",
    "  source_record_id text NOT NULL,",
    "  source_version text,",
    "  source_updated_at timestamptz,",
    "  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),",
    "  payload_batch_id text NOT NULL,",
    "  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),",
    "  tombstone boolean NOT NULL DEFAULT false,",
    "  mapping_version text NOT NULL,",
    ...columns.map((column, index) => `${column}${index === columns.length - 1 ? "," : ","}`),
    "  first_ingested_at timestamptz NOT NULL DEFAULT now(),",
    "  ingested_at timestamptz NOT NULL DEFAULT now(),",
    "  PRIMARY KEY (tenant_id, namespaced_source_key),",
    "  FOREIGN KEY (tenant_id, payload_batch_id)",
    "    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT",
    ");",
    `COMMENT ON TABLE ${qualified} IS 'Typed ${contract.connectorId} ${contract.stream} staging generated from the versioned field manifest.';`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${contract.table}_connection_watermark_idx`)}`,
    `  ON ${qualified} (tenant_id, connection_id, source_updated_at DESC);`,
    `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS tenant_scope ON ${qualified};`,
    `CREATE POLICY tenant_scope ON ${qualified}`,
    // The scalar subquery keeps the capability verifier an uncorrelated
    // InitPlan evaluated once per query, not once per row. See
    // 0118_m0_initplan_tenant_capability_predicate.sql.
    "  USING (tenant_id = (SELECT ingestion.current_tenant_id()))",
    "  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));",
  ].join("\n");
}

function sqlType(type: StagingFieldType): string {
  if (type === "numeric") return "numeric(19,4)";
  if (type === "timestamptz") return "timestamptz";
  if (type === "boolean") return "boolean";
  if (type === "date") return "date";
  if (type === "jsonb") return "jsonb";
  return "text";
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error(`Unsafe SQL identifier ${value}.`);
  return `"${value}"`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
