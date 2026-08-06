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
 * Streams whose only canonical output is the metadata observation. Their
 * record-id field is the one canonical disposition (it becomes the recorded
 * source id); every other column is a governed extension.
 */
function isLookupOnly(table: SpecTable): boolean {
  return table.canonicalTargets.length === 0
    || (table.canonicalTargets.length === 1 && table.canonicalTargets[0] === "metadata");
}

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
    for (const field of documented ?? []) {
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
