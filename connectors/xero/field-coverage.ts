/**
 * Field coverage for every Xero spec stream, derived from the table spec.
 *
 * `buildStagingContracts` refuses a stream with no coverage, and it is coverage
 * — not the column list — that decides which staging columns exist. Generating
 * it from the same spec that generated the streams keeps the dictionary, the
 * DDL and the projection in lock-step: the staged field name is the provenance
 * path relative to the owning object (`xeroSourceField`), which snake_cases to
 * exactly the spec column name.
 */
import type {
  FieldCoverage,
  PiiClass,
  StagingFieldType,
} from "../../packages/connector-sdk/src/contract.js";
import { XERO_CURATED_PII, XERO_CURATED_TARGETS } from "./curated-coverage.js";
import {
  XERO_SPEC_TABLES,
  xeroSourceField,
  type XeroSpecColumn,
  type XeroSpecTable,
} from "./scan-plan.js";

/**
 * Spec column type to the staging vocabulary. Ids and money both land on
 * `numeric`, which is exact and cannot lose the 4dp Xero returns under
 * `unitdp=4` — with the exception that uuid/text ids are text in the spec and
 * stay text here.
 */
function stagingType(column: XeroSpecColumn): StagingFieldType {
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
 * Payroll identity and remuneration data is the strictest class; accounting
 * contact data splits customer/business by table; merchant-authored free text
 * is never treated as safe.
 */
function piiClass(table: XeroSpecTable, column: XeroSpecColumn): PiiClass {
  // A reviewed classification always wins: only a human decision can tell a
  // customer-side stub from a supplier-side one when both are shapeless jsonb.
  const curated = XERO_CURATED_PII[table.id]?.[xeroSourceField(column)];
  if (curated) return curated;
  const name = column.name;
  if (table.domain.startsWith("payroll")) {
    if (column.pii) return "payroll_sensitive";
    if (/narration|note|description|reference/i.test(name)) return "free_text_untrusted";
    return "none";
  }
  if (!column.pii) {
    return /reference|narration|note|description|particulars|details|url|memo/i.test(name)
      ? "free_text_untrusted"
      : "none";
  }
  if (/tax_number|abn|bank_account|dob|birth/i.test(name)) return "payroll_sensitive";
  if (table.domain === "contacts_dir" || table.domain === "invoicing") return "customer_contact";
  if (table.domain === "org_meta" || table.domain === "files") return "employee_contact";
  return "business_contact";
}

/**
 * A column feeds the canonical model when its table declares a canonical
 * target; otherwise it is a governed extension — still staged, still
 * queryable through the governed source catalogue, never canonical authority.
 */
function disposition(table: XeroSpecTable, column: XeroSpecColumn): FieldCoverage["disposition"] {
  if (column.deprecated) return "governed_extension";
  return table.canonicalTargets.length > 0 ? "canonical" : "governed_extension";
}

export function buildXeroFieldCoverage(
  tables: readonly XeroSpecTable[] = XERO_SPEC_TABLES,
): readonly FieldCoverage[] {
  const coverage: FieldCoverage[] = [];
  for (const table of tables) {
    const seen = new Set<string>();
    for (const column of table.columns) {
      const field = xeroSourceField(column);
      if (seen.has(field)) continue; // scan-plan build already rejects this; belt and braces
      seen.add(field);
      // The reviewed target names the exact canonical slot this field feeds;
      // without one, a canonical table's fields declare the table's own target.
      const target = XERO_CURATED_TARGETS[table.id]?.[field]
        ?? (table.canonicalTargets.length > 0 ? table.canonicalTargets[0] : undefined);
      coverage.push({
        stream: table.id,
        field,
        disposition: disposition(table, column),
        stagingType: stagingType(column),
        ...(target ? { target } : {}),
        ...(column.deprecated
          ? { reason: "Deprecated by the pinned Xero Accounting OpenAPI; retained for history." }
          : {}),
        pii: piiClass(table, column),
      });
    }
    if (coverage.filter((entry) => entry.stream === table.id).length === 0) {
      throw new Error(`${table.id} produced no field coverage and could never be staged.`);
    }
  }
  return coverage;
}

export const XERO_FIELD_COVERAGE: readonly FieldCoverage[] = buildXeroFieldCoverage();
