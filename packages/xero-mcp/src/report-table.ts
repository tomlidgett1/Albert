/**
 * Turns the official Xero MCP report text (P&L, balance sheet, trial balance,
 * aged receivables/payables) into a flat, typed table the engine can register
 * as first-class evidence: one row per statement line, one currency column
 * per report period. Xero's report JSON is a tree of Header / Section rows;
 * the model should never have to read that JSON, and the dashboard should be
 * able to pin the statement like any other result.
 */

export type XeroReportColumn = Readonly<{
  key: string;
  label: string;
  type: "string" | "currency";
}>;

export type XeroReportRow = Readonly<Record<string, string | number | null>>;

export type XeroReportTable = Readonly<{
  title: string;
  /** Period / as-at labels exactly as Xero renders them, in column order. */
  periods: readonly string[];
  columns: readonly XeroReportColumn[];
  rows: readonly XeroReportRow[];
}>;

type RawCell = { value?: unknown };
type RawRow = {
  rowType?: unknown;
  title?: unknown;
  cells?: unknown;
  rows?: unknown;
};

const NUMBER = /^-?\d+(?:\.\d+)?$/u;

function cellText(cell: unknown): string {
  if (!cell || typeof cell !== "object") return "";
  const value = (cell as RawCell).value;
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value);
}

function toNumber(text: string): number | null {
  const cleaned = text.replace(/,/gu, "");
  return NUMBER.test(cleaned) ? Number(cleaned) : null;
}

function extractJsonArray(text: string): unknown[] | undefined {
  const start = text.indexOf("[");
  if (start < 0) return undefined;
  const end = text.lastIndexOf("]");
  if (end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Title line such as "Profit and Loss Report: Profit and Loss" → "Profit and Loss". */
function extractTitle(text: string, fallback: string): string {
  const match = /^[^\n]*?Report(?: Name)?:\s*([^\n]+)$/imu.exec(text);
  const title = match?.[1]?.trim();
  return title && title !== "Unnamed" && title !== "Not specified" ? title : fallback;
}

/**
 * Parses an official Xero MCP report payload. Returns undefined when the text
 * carries no recognisable report rows (errors, empty organisations), so the
 * caller can fall back to the raw text.
 */
export function parseXeroReportTable(
  text: string,
  fallbackTitle: string,
): XeroReportTable | undefined {
  const raw = extractJsonArray(text);
  if (!raw || raw.length === 0) return undefined;

  let periods: string[] = [];
  const rows: XeroReportRow[] = [];

  const pushLine = (section: string, cells: unknown[]) => {
    const label = cellText(cells[0]);
    if (!label && cells.length <= 1) return;
    const row: Record<string, string | number | null> = {
      section,
      line: label,
    };
    periods.forEach((_, index) => {
      row[`period_${index + 1}`] = toNumber(cellText(cells[index + 1]));
    });
    rows.push(row);
  };

  const walk = (node: unknown, section: string) => {
    if (!node || typeof node !== "object") return;
    const row = node as RawRow;
    const type = typeof row.rowType === "string" ? row.rowType : "";
    if (type === "Header" && Array.isArray(row.cells)) {
      periods = row.cells.slice(1).map(cellText).filter((label) => label.length > 0);
      return;
    }
    if (type === "Section") {
      const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : section;
      if (Array.isArray(row.rows)) row.rows.forEach((child) => walk(child, title));
      return;
    }
    if ((type === "Row" || type === "SummaryRow") && Array.isArray(row.cells)) {
      pushLine(section, row.cells);
    }
  };
  raw.forEach((node) => walk(node, ""));

  if (rows.length === 0) return undefined;
  if (periods.length === 0) periods = ["Amount"];
  const columns: XeroReportColumn[] = [
    { key: "section", label: "Section", type: "string" },
    { key: "line", label: "Line", type: "string" },
    ...periods.map((label, index) => ({
      key: `period_${index + 1}`,
      label,
      type: "currency" as const,
    })),
  ];
  return Object.freeze({
    title: extractTitle(text, fallbackTitle),
    periods: Object.freeze(periods),
    columns: Object.freeze(columns),
    rows: Object.freeze(rows),
  });
}
