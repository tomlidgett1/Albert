import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Lightspeed sale projection uses documented calculated components", async () => {
  const mapper = await readFile("connectors/lightspeed-r/canonical.ts", "utf8");

  // The split ls_sale_lines mapper reads the row's own staged calc_* columns:
  // the applied line and transaction discount allocations, and the line's own
  // per-line taxes — never a header allocation.
  assert.match(mapper, /row\.calc_line_discount/u);
  assert.match(mapper, /row\.calc_transaction_discount/u);
  assert.match(mapper, /row\.calc_tax1/u);
  assert.match(mapper, /gross_amount: netIncTax\.add\(discount\)\.toString\(\)/u);
  // A negative quantity is a reversal observation with a mandatory native
  // parent link, never an additional positive sale.
  assert.match(mapper, /const refund = quantity\.scaled < 0n/u);
  assert.match(mapper, /refund \? "refunded"/u);
  assert.match(mapper, /lightspeed_refund_parent_missing/u);
  // Archived payment attempts are voided tombstones, not live tenders.
  assert.match(mapper, /const archived = truthy\(row\.archived\)/u);
  assert.match(mapper, /status: voided \|\| archived \? "voided"/u);
  assert.match(mapper, /row\.tombstone \|\| archived/u);
  // The display-only normal unit price never feeds an amount.
  assert.doesNotMatch(mapper, /normal_unit_price/u);
});

test("terminal tender quality sums signed live tenders as a set", async () => {
  const sql = await readFile(
    "infra/migrations/analytical/0110_m4_signed_tender_reconciliation.sql",
    "utf8",
  );

  assert.match(sql, /WITH tender_totals AS MATERIALIZED/u);
  assert.match(sql, /payment\.status IN \('captured','refunded'\)/u);
  assert.match(sql, /sum\(payment\.amount\) AS amount/u);
  assert.match(sql, /LEFT JOIN tender_totals tender/u);
  assert.doesNotMatch(sql, /payment\.status='captured'/u);
  assert.match(sql, /signed_live_tenders_reconcile_completed_orders/u);
  assert.match(sql, /SECURITY DEFINER/u);
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION quality\.run_all_invariants\(text,text\)[\s\S]*?GRANT EXECUTE[\s\S]*?TO transform_rw/u,
  );
});
