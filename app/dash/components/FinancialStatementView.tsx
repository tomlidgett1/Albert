import { Fragment } from "react";
import type { TraceTableColumn, TraceTableEvent } from "@/packages/shared/src";
import styles from "./insights-trace.module.css";

/**
 * Renders a statement-shaped governed table (P&L, balance sheet, trial
 * balance) the way an accountant lays it out: section headings, indented
 * account lines, ruled "Total ..." subtotals and emphasised grand totals
 * (Gross/Net Profit, Net Assets), with right-aligned bracketed negatives.
 * Every figure still comes verbatim from the governed table event.
 */

const GRAND_TOTAL_LINES = new Set([
  "gross profit",
  "net profit",
  "net profit (loss)",
  "profit (loss)",
  "net assets",
  "total equity",
  "total assets",
  "total liabilities",
]);

export function isFinancialStatementTable(table: TraceTableEvent): boolean {
  if (table.layout === "financial_statement") return true;
  // Fallback-composed statements carry the same shape without the flag.
  if (table.columns.length < 3) return false;
  const [first, second, ...rest] = table.columns;
  return first!.key === "section" && second!.key === "line"
    && rest.every((column) => column.type === "currency" || column.type === "number");
}

function statementAmount(value: unknown): string {
  if (value === null || value === undefined || value === "") return "–";
  const numeric = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(numeric)) return String(value);
  const formatted = new Intl.NumberFormat("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(numeric));
  return numeric < 0 ? `(${formatted})` : formatted;
}

function lineKind(section: string, line: string): "section-total" | "grand-total" | "line" {
  const flat = line.trim().toLowerCase();
  if (GRAND_TOTAL_LINES.has(flat) && section.trim() === "") return "grand-total";
  if (GRAND_TOTAL_LINES.has(flat)) return "section-total";
  if (flat.startsWith("total ")) return "section-total";
  return "line";
}

export function FinancialStatementView({ table }: { table: TraceTableEvent }) {
  const periodColumns: TraceTableColumn[] = table.columns.filter(
    (column) => column.key !== "section" && column.key !== "line",
  );
  const showPeriodHeader = periodColumns.length > 1
    || (periodColumns[0]?.label && periodColumns[0].label.toLowerCase() !== "amount");
  return (
    <div className={styles.statementWrap} aria-label={table.caption}>
      <table className={styles.statementTable}>
        {showPeriodHeader ? (
          <thead>
            <tr>
              <th className={styles.statementLabelHead} aria-label="Line" />
              {periodColumns.map((column) => (
                <th key={column.key} className={styles.statementAmountHead}>{column.label}</th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {table.rows.map((row, rowIndex) => {
            const section = String(row.section ?? "");
            const line = String(row.line ?? "");
            const kind = lineKind(section, line);
            const previousSection = rowIndex > 0 ? String(table.rows[rowIndex - 1]?.section ?? "") : null;
            const isNewSection = section.trim() !== "" && section !== previousSection;
            return (
              <Fragment key={`${table.resultId}_st_${rowIndex}`}>
                {isNewSection ? (
                  <tr className={styles.statementSectionRow}>
                    <td colSpan={periodColumns.length + 1}>{section}</td>
                  </tr>
                ) : null}
                <tr
                  className={
                    kind === "grand-total"
                      ? styles.statementGrandTotalRow
                      : kind === "section-total"
                        ? styles.statementTotalRow
                        : styles.statementLineRow
                  }
                >
                  <td className={styles.statementLabel}>{line}</td>
                  {periodColumns.map((column) => (
                    <td key={column.key} className={styles.statementAmount}>
                      {statementAmount(row[column.key])}
                    </td>
                  ))}
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
