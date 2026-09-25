import type { PivotSourceResult } from "./pivot.js";

type Period = readonly [string, string];
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Exact owner-specified periods can be checked independently of model interpretation. */
export function explicitQuestionPeriods(text: string): Period[] {
  const periods: Period[] = [];
  for (const match of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\s*(?:to|through|–|—)\s*(\d{4}-\d{2}-\d{2})\b/gu)) periods.push([match[1]!, match[2]!]);
  const pattern = new RegExp(`\\b(${months.join("|")})\\s+(20\\d{2})\\b`, "giu");
  for (const match of text.matchAll(pattern)) {
    // "As of 31 August 2026" is a snapshot date, not the whole month.
    if (/\d{1,2}\s+$/u.test(text.slice(0, match.index))) continue;
    const month = months.indexOf(match[1]!.toLowerCase()); const year = Number(match[2]);
    periods.push([`${year}-${String(month + 1).padStart(2, "0")}-01`, new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10)]);
  }
  return periods;
}

function sourcePeriods(source: PivotSourceResult): Period[] {
  const periods: Period[] = [];
  const accept = (value: unknown) => {
    if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(part))) periods.push(value as unknown as Period);
    else if (typeof value === "string") periods.push(...explicitQuestionPeriods(value));
  };
  accept([source.provenance.timeRange.start, source.provenance.timeRange.end]);
  periods.push(...explicitQuestionPeriods(source.provenance.timeRange.label));
  for (const window of [source.semantics?.window, ...(source.semantics?.inputWindows ?? [])]) {
    if (!window) continue;
    try {
      const value = JSON.parse(window) as { ranges?: { dateRange?: unknown; compareDateRange?: unknown[] }[] };
      for (const range of value.ranges ?? []) { accept(range.dateRange); for (const period of range.compareDateRange ?? []) accept(period); }
    } catch { /* Legacy metadata is not proof of an explicit period. */ }
  }
  return periods;
}

export function answerPeriodIssues(question: string, sources: readonly PivotSourceResult[]): string[] {
  const requested = explicitQuestionPeriods(question);
  if (!requested.length) return [];
  return requested.filter(([start, end]) => !sources.some((source) => sourcePeriods(source).some(([from, through]) => {
    if (from === start && through === end) return true;
    // A bucketed result can carry the requested month among other months.
    const matchingRow = source.columns.some((column) => ["date", "datetime"].includes(column.type)
      && source.rows.some((row) => typeof row[column.key] === "string" && String(row[column.key]).slice(0, 10) >= start && String(row[column.key]).slice(0, 10) <= end));
    const timeGrains = [source.semantics?.grain ?? [], ...(source.semantics?.inputGrains ?? [])].flat();
    const matchingPivotColumn = timeGrains.some((grain) => /\.(?:day|week|month|quarter|year)$/u.test(grain))
      && source.columns.some((column) => {
        const date = /(?:^|[^0-9])(20\d{2})[-_](\d{2})[-_](\d{2})/u.exec(`${column.key} ${column.label}`);
        const day = date ? `${date[1]}-${date[2]}-${date[3]}` : "";
        return day >= start && day <= end;
      });
    return from <= start && through >= end && Boolean(matchingRow || matchingPivotColumn);
  }))).map(([start, end]) => `No cited evidence represents the requested period ${start} to ${end}. Query that period; do not substitute another window.`);
}
