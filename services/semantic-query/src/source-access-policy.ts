import {
  SOURCE_AUTHORITY_CONCEPTS,
  type SourceAuthorityConcept,
} from "../../../packages/canonical-schema/src/index.js";
import { SemanticCompilerError } from "../../../packages/compiler/src/index.js";
import type { SemanticRole } from "../../../packages/semantic-registry/src/index.js";
import type { SourceField } from "./types.js";

const roles = (...values: SemanticRole[]): readonly SemanticRole[] => Object.freeze(values);

/**
 * Source extensions inherit the Topic permissions for the semantic domain they
 * extend. Keep this deliberately more restrictive than canonical metric access:
 * source-native fields can expose details that have not yet been promoted into
 * a reviewed metric contract.
 */
const SOURCE_ROLES_BY_AUTHORITY = Object.freeze({
  operational_sales: roles("owner", "manager", "bookkeeper"),
  stock: roles("owner", "manager"),
  product_master: roles("owner", "manager"),
  customer_master: roles("owner", "manager"),
  statutory_finance: roles("owner", "bookkeeper"),
  cash_settlement: roles("owner", "bookkeeper"),
  planned_shifts: roles("owner", "manager"),
  worked_hours: roles("owner", "manager"),
} satisfies Readonly<Record<SourceAuthorityConcept, readonly SemanticRole[]>>);

const sourceAuthorityConcepts = new Set<string>(SOURCE_AUTHORITY_CONCEPTS);
const forbiddenPiiClasses = new Set<SourceField["piiClass"]>([
  "customer_contact",
  "payroll",
  "sensitive_personal",
]);

export function parseSourceAuthorityConcept(value: string | undefined): SourceAuthorityConcept {
  if (!value || !sourceAuthorityConcepts.has(value)) {
    throw new SemanticCompilerError(
      "INVALID_IR",
      "Source exploration requires a governed authority concept for every field.",
    );
  }
  return value as SourceAuthorityConcept;
}

export function sourceAuthorityConceptsForRole(role: SemanticRole): readonly SourceAuthorityConcept[] {
  return SOURCE_AUTHORITY_CONCEPTS.filter((concept) => SOURCE_ROLES_BY_AUTHORITY[concept].includes(role));
}

export function sourceFieldIsAccessible(field: SourceField, role: SemanticRole): boolean {
  if (forbiddenPiiClasses.has(field.piiClass)) return false;
  if (role === "bookkeeper" && field.piiClass !== "none") return false;
  if (!field.authorityConcept || !sourceAuthorityConcepts.has(field.authorityConcept)) return false;
  return SOURCE_ROLES_BY_AUTHORITY[field.authorityConcept as SourceAuthorityConcept].includes(role);
}

export function assertSourceFieldIsAccessible(field: SourceField, role: SemanticRole): void {
  const concept = parseSourceAuthorityConcept(field.authorityConcept);
  if (forbiddenPiiClasses.has(field.piiClass)) {
    throw new SemanticCompilerError(
      "FORBIDDEN_ROLE",
      `Source field ${field.sourceField} is unavailable because of its PII classification.`,
    );
  }
  if (role === "bookkeeper" && field.piiClass !== "none") {
    throw new SemanticCompilerError(
      "FORBIDDEN_ROLE",
      `Role ${role} cannot explore business-classified field ${field.sourceField}.`,
    );
  }
  if (!SOURCE_ROLES_BY_AUTHORITY[concept].includes(role)) {
    throw new SemanticCompilerError(
      "FORBIDDEN_ROLE",
      `Role ${role} cannot explore ${concept} source fields.`,
    );
  }
}
