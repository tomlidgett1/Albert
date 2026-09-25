import type { TraceTableEvent } from "@/packages/shared/src";
import { formatTraceCell } from "./analytical-values";
import { FinancialStatementView, isFinancialStatementTable } from "./FinancialStatementView";
import styles from "./insights-trace.module.css";

export function GovernedResultGrid({
  table,
  maxHeight = 240,
  ariaLabel,
}: {
  table: TraceTableEvent;
  maxHeight?: number;
  ariaLabel?: string;
}) {
  // A P&L / balance sheet / trial balance reads as a statement, not a grid,
  // and the owner expects to see the whole thing without scrolling a 240px
  // viewport.
  if (isFinancialStatementTable(table)) {
    return (
      <div className={styles.resultTableWrap} style={{ maxHeight: Math.max(maxHeight, 640) }} aria-label={ariaLabel}>
        <FinancialStatementView table={table} />
      </div>
    );
  }
  return (
    <>
      <div className={styles.resultTableWrap} style={{ maxHeight }} aria-label={ariaLabel}>
        <table className={styles.resultTable}>
          <thead>
            <tr>
              {table.columns.map((column, columnIndex) => (
                <th key={`${column.key}_${columnIndex}`}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 ? (
              <tr>
                <td className={styles.resultTableEmpty} colSpan={Math.max(1, table.columns.length)}>
                  No data for this governed result.
                </td>
              </tr>
            ) : table.rows.map((row, rowIndex) => (
              <tr key={`${table.resultId}_${rowIndex}`}>
                {table.columns.map((column, columnIndex) => (
                  <td key={`${column.key}_${columnIndex}`}>
                    {formatTraceCell(row[column.key] ?? null, column, table.rowFormats?.[rowIndex])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > 8 ? (
        <p className={styles.resultTableFooter}>
          {table.rows.length.toLocaleString("en-AU")} row{table.rows.length === 1 ? "" : "s"} · scroll for all
        </p>
      ) : null}
    </>
  );
}
