/**
 * Field coverage for all 90 Lightspeed streams, derived from the table spec.
 *
 * `buildStagingContracts` refuses a stream with no coverage, and it is coverage
 * — not the column list — that decides which staging columns exist. Generating
 * it from the same spec that generated the streams is what keeps the two from
 * drifting: a hand-kept list produces a stream whose table is missing the column
 * its mapper writes, and that failure only appears at ingest time.
 */
import type { FieldCoverage, PiiClass, StagingFieldType } from "../../packages/connector-sdk/src/contract.js";
import { LIGHTSPEED_R_DOCUMENTED_FIELDS } from "./documented-fields.js";
import { SPEC_TABLES, type SpecColumn, type SpecTable } from "./scan-plan.js";
import { executableCanonicalTargets } from "./streams.js";

/**
 * Spec column type to the staging vocabulary the SDK accepts. That vocabulary is
 * deliberately small — text, numeric, boolean, date, timestamptz, jsonb — so ids
 * and money both land on `numeric`, which is exact and cannot lose cents.
 */
function stagingType(column: SpecColumn): StagingFieldType {
  switch (column.type) {
    case "integer":
    case "bigint":
    case "numeric":
    case "real":
      return "numeric";
    case "boolean":
      return "boolean";
    case "timestamp":
      return "timestamptz";
    case "date":
      return "date";
    case "jsonb":
      return "jsonb";
    default:
      return "text";
  }
}

/**
 * PII classification drives who may read a field through the source catalogue.
 * The spec marks personal fields explicitly; this maps them onto the SDK's
 * closed vocabulary and defaults to `none` only when the spec says so.
 */
function piiClass(table: SpecTable, column: SpecColumn): PiiClass {
  if (!column.pii) {
    // Merchant-authored free text can carry anything a member of staff typed,
    // so it is never treated as safe by default.
    return /note|description|comment|memo/i.test(column.name) ? "free_text_untrusted" : "none";
  }
  if (/wage|salary|super|payroll|tax_number|abn|ssn|licence|license|passport|dob|birth/i.test(column.name)) {
    return "payroll_sensitive";
  }
  if (table.domain === "org") return "employee_contact";
  if (table.domain === "purchasing" || /vendor|supplier|company/i.test(table.id)) {
    return "business_contact";
  }
  return "customer_contact";
}

/**
 * A column feeds the canonical model when its table declares a canonical
 * target; otherwise it is a governed extension — still staged and still
 * queryable, but never the basis of a canonical fact.
 */
function disposition(table: SpecTable, column: SpecColumn): FieldCoverage["disposition"] {
  if (column.deprecated) return "governed_extension";
  return table.canonicalTargets.length > 0 ? "canonical" : "governed_extension";
}

/**
 * Streams whose only canonical output is the metadata observation. Decided by
 * the EXECUTABLE targets (what the mapper in canonical.ts actually emits), not
 * the spec's aspirational target list: the spec documents what a table could
 * feed, but a stream with no mapper of its own emits only the lookup metadata
 * observation, so its coverage must claim exactly that. Their record-id field
 * is the one canonical disposition (it becomes the recorded source id); every
 * other column is a governed extension.
 */
function isLookupOnly(table: SpecTable): boolean {
  const targets = executableCanonicalTargets(table.id);
  return targets.length === 1 && targets[0] === "metadata";
}

/**
 * Fields the LIVE account returns that neither the spec nor the pinned
 * documentation build lists — harvested from the quarantine census of the
 * first real 90-stream backfill (2026-08-06, tenant Ashburton Cycles). Each
 * gets an explicit unsupported disposition: staged tables omit them, the
 * immutable raw payloads retain them, and their rows stop failing closed.
 * This is the tier-0-meets-tier-1 correction the evidence ladder expects:
 * the documentation asserted a shape, the live probe observed a wider one.
 */
const OBSERVED_LIVE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ls_catalog_vendor_items: ["catalogMasterID", "timeStamp"],
  ls_categories: ["Category"],
  ls_credit_accounts: ["Contact", "creditLimit", "giftCardUuid", "WithdrawalPayments"],
  ls_customers: ["Tags"],
  ls_discounts: ["createTime"],
  ls_images: ["baseImageURL", "createTime", "Item", "originalFilename", "size", "timeStamp"],
  ls_item_attribute_sets: ["archived", "system"],
  ls_item_matrices: ["attribute1Values", "attribute2Values", "attribute3Values", "Category", "ItemAttributeSet", "Manufacturer", "Prices"],
  ls_items: ["Prices"],
  ls_purchase_order_lines: ["OrderLine"],
  ls_purchase_orders: ["subTotalCost", "totalCost"],
  ls_register_withdraws: ["PaymentType"],
  ls_registers: ["archived", "ccTerminalID"],
  ls_sales: ["calcItemFees", "calcSurcharges", "displayableSubtotal", "isTaxInclusive", "receiptPreference", "taxTotal", "ticketNumber", "tippableAmount", "updateTime"],
  ls_shops: ["companyRegistrationNumber", "gatewayConfigID", "timeStamp", "vatNumber", "zebraBrowserPrint"],
  ls_tags: ["readOnly"],
  ls_tax_category_classes: ["TaxClass", "timeStamp"],
  ls_tax_classes: ["classType"],
});

export function buildFieldCoverage(
  tables: readonly SpecTable[] = SPEC_TABLES,
): readonly FieldCoverage[] {
  const coverage: FieldCoverage[] = [];
  for (const table of tables) {
    const idLeaf = String(table.recordIdField ?? "").split(".").pop() ?? "";
    const seen = new Set<string>();
    for (const column of table.columns) {
      // The spec addresses a field by its API path; staging addresses it by the
      // vendor's own field name, which is the last path segment.
      const field = column.api.split(".").pop() ?? column.name;
      if (seen.has(field)) continue; // a duplicate would collide on the staging column
      seen.add(field);
      const lookupOnly = isLookupOnly(table);
      const canonical = lookupOnly ? field === idLeaf : disposition(table, column) === "canonical";
      coverage.push({
        stream: table.id,
        field,
        disposition: canonical ? "canonical" : "governed_extension",
        stagingType: stagingType(column),
        ...(canonical && lookupOnly
          ? { target: "metadata.source_record_id" }
          : table.canonicalTargets.length > 0 && !lookupOnly
            ? { target: table.canonicalTargets[0] }
            : {}),
        ...(column.deprecated ? { reason: "Deprecated by the vendor; retained for history." } : {}),
        pii: piiClass(table, column),
      });
    }
    // The pinned documentation build lists fields the spec deliberately leaves
    // outside staging scope. They keep an explicit unsupported disposition, so
    // every documented field has a reviewable answer to "where did this go".
    const documented = LIGHTSPEED_R_DOCUMENTED_FIELDS[table.id as keyof typeof LIGHTSPEED_R_DOCUMENTED_FIELDS];
    for (const field of [...(documented ?? []), ...(OBSERVED_LIVE_FIELDS[table.id] ?? [])]) {
      if (seen.has(field)) continue;
      seen.add(field);
      coverage.push({
        stream: table.id,
        field,
        disposition: "unsupported",
        stagingType: "text",
        reason: "Published by the pinned Lightspeed R-Series V3 documentation build but outside Albert V1 canonical and governed source-extension scope; retained only in immutable encrypted raw storage.",
        pii: /Note|Instructions|CustomFieldValues/u.test(field) ? "free_text_untrusted" : "none",
      });
    }
    if (coverage.filter((entry) => entry.stream === table.id).length === 0) {
      throw new Error(`${table.id} produced no field coverage and could never be staged.`);
    }
  }
  return coverage;
}

export const LIGHTSPEED_FIELD_COVERAGE: readonly FieldCoverage[] = buildFieldCoverage();
