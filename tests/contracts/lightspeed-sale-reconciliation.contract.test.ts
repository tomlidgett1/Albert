import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
