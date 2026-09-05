import type { EvalTurnRecord } from "./lib.js";

/** Deterministic release checks are independent of the runtime's confidence label. */
export function scoreOmniRecord(record: EvalTurnRecord): { pass: boolean; issues: string[] } {
  const issues: string[] = [];
  if (record.failed) issues.push("turn_failed");
  if (record.answerState === "Unavailable") issues.push("unavailable");
  if (record.errors?.length) issues.push("terminal_error");
  if (!record.answerText?.trim() && !record.clarification?.trim()) issues.push("missing_answer");
  if (record.answerState === "Verified" && (record.queriesExecuted ?? 0) > 0 && !record.claims?.length) issues.push("verified_without_claims");
  const tables = new Map(record.tables.map((table) => [table.resultId, table]));
  for (const claim of record.claims ?? []) {
    for (const reference of claim.refs) {
      const source = tables.get(reference.resultId);
      if (!source || !source.columns.some((column) => column.key === reference.columnKey) || !source.rows[reference.rowIndex] || !(reference.columnKey in source.rows[reference.rowIndex]!)) issues.push("unresolvable_claim_reference");
    }
  }
  for (const golden of record.golden ?? []) {
    if (golden.error || golden.value === null) { issues.push(`golden_unavailable:${golden.label}`); continue; }
    const key = golden.member.replaceAll(".", "_");
    const referenced = (record.claims ?? []).flatMap((claim) => claim.refs)
      .filter((reference) => reference.columnKey === key || reference.columnKey === golden.member)
      .flatMap((reference) => {
        const row = tables.get(reference.resultId)?.rows[reference.rowIndex];
        return row ? [row[reference.columnKey]] : [];
      });
    if (typeof golden.value === "number") {
      const expected = golden.value;
      const tolerance = Math.max(0.005, Math.abs(expected) * golden.tolerancePct / 100);
      if (!referenced.some((value) => value !== null && value !== undefined && Math.abs(Number(value) - expected) <= tolerance)) issues.push(`golden_mismatch:${golden.label}`);
    } else {
      const expected = Array.isArray(golden.value) ? golden.value : [golden.value];
      if (expected.some((value) => !referenced.some((cell) => String(cell) === value) && !record.answerText?.includes(value))) issues.push(`golden_mismatch:${golden.label}`);
    }
  }
  return { pass: issues.length === 0, issues: [...new Set(issues)] };
}
