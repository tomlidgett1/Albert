import { z } from "zod";
import type {
  TraceCell,
  TraceProvenance,
  TraceTableColumn,
} from "../../shared/src/index.js";


/**
 * Clarification choices that may become durable tenant preferences. The model
 * chooses only an opaque option id; trusted application code resolves the
 * canonical label/key/value, and the database enforces the same vocabulary.
 */
export const ALBERT_PREFERENCE_OPTION_IDS = [
  "sales.net_ex_gst",
  "sales.gross_inc_gst",
  "employee.net_sales",
  "employee.gross_margin",
  "employee.gross_profit_per_labour_hour",
  "reconciliation.daily_summary",
  "reconciliation.individual_transactions",
  "reconciliation.unknown",
  "finance.operational_gross_margin",
  "finance.accounting_gross_profit",
  "finance.accounting_net_profit",
  "calendar.financial_year",
  "calendar.calendar_year",
] as const;
export type AlbertPreferenceOptionId = (typeof ALBERT_PREFERENCE_OPTION_IDS)[number];

export type AlbertPreferenceOption = Readonly<{
  id: AlbertPreferenceOptionId;
  label: string;
  preference: string;
  value: string;
}>;

/**
 * The model may choose only a non-quantitative, server-owned continuation.
 * This prevents an interstitial narrative from smuggling an ungrounded figure
 * into otherwise validated analytical evidence.
 */
export const OBSERVATION_NEXT_STEP_IDS = [
  "compare_period",
  "break_down_by_location",
  "break_down_by_product",
  "check_margin",
  "check_labour",
  "check_finance",
  "inspect_exception",
  "visualise_result",
  "prepare_answer",
] as const;
export type ObservationNextStepId = (typeof OBSERVATION_NEXT_STEP_IDS)[number];

export const claimAssertionSchema = z.enum([
  "value",
  "highest",
  "lowest",
  "greater_than",
  "less_than",
  "equal",
]);

export const claimCellReferenceSchema = z.object({
  resultId: z.string().min(1).max(200),
  rowIndex: z.number().int().min(0).max(100_000),
  columnKey: z.string().regex(/^[a-z_][a-z0-9_.]{0,119}$/u),
}).strict();

export const evidenceClaimInputSchema = z.object({
  statement: z.string().trim().min(1).max(600),
  assertion: claimAssertionSchema,
  refs: z.array(claimCellReferenceSchema).min(1).max(12),
}).strict();
export type EvidenceClaimInput = z.infer<typeof evidenceClaimInputSchema>;

const preferenceOptionById: Readonly<Record<AlbertPreferenceOptionId, AlbertPreferenceOption>> = Object.freeze({
  "sales.net_ex_gst": Object.freeze({ id: "sales.net_ex_gst", label: "Net sales (ex GST)", preference: "sales.default_metric", value: "commerce.net_sales_ex_gst" }),
  "sales.gross_inc_gst": Object.freeze({ id: "sales.gross_inc_gst", label: "Gross takings (inc GST)", preference: "sales.default_metric", value: "commerce.gross_takings_inc_gst" }),
  "employee.net_sales": Object.freeze({ id: "employee.net_sales", label: "Net sales", preference: "employee.performance_default", value: "commerce.net_sales_ex_gst" }),
  "employee.gross_margin": Object.freeze({ id: "employee.gross_margin", label: "Gross profit", preference: "employee.performance_default", value: "commerce.gross_margin" }),
  "employee.gross_profit_per_labour_hour": Object.freeze({ id: "employee.gross_profit_per_labour_hour", label: "Gross profit per worked hour", preference: "employee.performance_default", value: "composites.gross_profit_per_labour_hour" }),
  "reconciliation.daily_summary": Object.freeze({ id: "reconciliation.daily_summary", label: "Daily summary journals", preference: "reconciliation.pos_posting_topology", value: "daily_summary_journals" }),
  "reconciliation.individual_transactions": Object.freeze({ id: "reconciliation.individual_transactions", label: "Individual transactions", preference: "reconciliation.pos_posting_topology", value: "individual_transactions" }),
  "reconciliation.unknown": Object.freeze({ id: "reconciliation.unknown", label: "I’m not sure", preference: "reconciliation.pos_posting_topology", value: "unknown" }),
  "finance.operational_gross_margin": Object.freeze({ id: "finance.operational_gross_margin", label: "Operational gross margin", preference: "finance.profit_default", value: "commerce.gross_margin" }),
  "finance.accounting_gross_profit": Object.freeze({ id: "finance.accounting_gross_profit", label: "Accounting gross profit", preference: "finance.profit_default", value: "finance.gross_profit_accounting" }),
  "finance.accounting_net_profit": Object.freeze({ id: "finance.accounting_net_profit", label: "Accounting net profit", preference: "finance.profit_default", value: "finance.net_profit" }),
  // "This year" is materially ambiguous for an Australian business: the
  // financial year opens 1 July, the calendar year 1 January. Answering on an
  // unconfirmed default silently reports a different period than the one asked
  // about, so the basis is a confirmed tenant preference.
  "calendar.financial_year": Object.freeze({ id: "calendar.financial_year", label: "Financial year (from 1 July)", preference: "calendar.year_basis", value: "financial_year" }),
  "calendar.calendar_year": Object.freeze({ id: "calendar.calendar_year", label: "Calendar year (from 1 January)", preference: "calendar.year_basis", value: "calendar_year" }),
});

export function resolveAlbertPreferenceOption(id: AlbertPreferenceOptionId): AlbertPreferenceOption {
  return preferenceOptionById[id];
}

export function isAllowlistedRememberedPreference(preference: string, value: unknown): value is string {
  return typeof value === "string" && ALBERT_PREFERENCE_OPTION_IDS.some((id) => {
    const option = preferenceOptionById[id];
    return option.preference === preference && option.value === value;
  });
}


/**
 * Trusted evidence about the scope of the statement that actually executed.
 * The model never supplies this object. SQL predicates are tokenised by the
 * semantic service and result values are copied from the returned rows; the
 * receipt therefore records scope evidence without pretending to certify a
 * metric or infer a business fact.
 */
export const queryScopeReceiptSchema = z.object({
  kind: z.literal("sql"),
  relations: z.array(z.object({
    schema: z.string().trim().min(1).max(80).optional(),
    relation: z.string().trim().min(1).max(120),
  }).strict()).max(32),
  predicates: z.array(z.object({
    expression: z.string().trim().min(1).max(240),
    operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "like", "not_like", "ilike", "not_ilike", "in", "not_in", "is_null", "is_not_null"]),
    values: z.array(z.string().max(240)).max(20),
  }).strict()).max(40),
  resultValues: z.array(z.object({
    column: z.string().trim().min(1).max(120),
    values: z.array(z.string().max(240)).min(1).max(20),
  }).strict()).max(32),
}).strict();
export type QueryScopeReceipt = z.infer<typeof queryScopeReceiptSchema>;


export type GovernedResult = Readonly<{
  resultId: string;
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  /** Server-derived query-scope evidence; never authored by the model. */
  scopeReceipt?: QueryScopeReceipt;
  /** Exact canonical filter values, indexed in parallel with rows. */
  filterRefs?: readonly Readonly<Record<string, string>>[];
  /**
   * Compiler-owned proof that an outer ORDER BY was applied before LIMIT.
   * Ranking claims must fail closed when this proof is absent or mismatched.
   */
  resultWindow?: Readonly<{
    requestedLimit: number;
    orderedBeforeLimit: true;
    orderBy: readonly Readonly<{
      columnKey: string;
      direction: "asc" | "desc";
    }>[];
  }>;
  provenance: TraceProvenance;
  validations: readonly Readonly<{
    name: string;
    outcome: "passed" | "qualified" | "failed";
    detail: string;
  }>[];
}>;
