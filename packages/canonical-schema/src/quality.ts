import { Decimal4, sumDecimal4 } from "./decimal.js";
import type { QualityCheckResult } from "./types.js";

export type CommerceLineMath = Readonly<{
  id: string;
  grossAmount: string;
  discountAmount: string;
  netAmountIncTax: string;
  taxAmount: string;
  netAmountExTax: string;
}>;

export type TenderOrder = Readonly<{ orderId: string; netAmountIncTax: string }>;
export type TenderPayment = Readonly<{
  orderId: string;
  amount: string;
  status: "captured" | "refunded" | "voided";
}>;

export type JournalLine = Readonly<{
  journalId: string;
  debitAmount: string;
  creditAmount: string;
}>;

export function checkLineMath(
  lines: readonly CommerceLineMath[],
  tolerance = "0.0001",
): QualityCheckResult {
  const limit = Decimal4.from(tolerance);
  const failures = lines.filter((line) => {
    const grossLessDiscount = Decimal4.from(line.grossAmount).subtract(line.discountAmount);
    const exTaxPlusTax = Decimal4.from(line.netAmountExTax).add(line.taxAmount);
    return (
      grossLessDiscount.subtract(line.netAmountIncTax).abs().compare(limit) > 0 ||
      exTaxPlusTax.subtract(line.netAmountIncTax).abs().compare(limit) > 0
    );
  });

  return {
    checkId: "line_maths",
    status: failures.length === 0 ? "passed" : "failed",
    observed: `${failures.length}/${lines.length} invalid lines`,
    threshold: tolerance,
    details: { failingIds: failures.map((line) => line.id) },
  };
}

export function checkTenderReconciliation(
  orders: readonly TenderOrder[],
  payments: readonly TenderPayment[],
  tolerance = "0.0100",
): QualityCheckResult {
  const paymentByOrder = new Map<string, Decimal4>();
  for (const payment of payments) {
    if (payment.status === "voided") continue;
    const signed = payment.status === "refunded"
      ? Decimal4.zero().subtract(payment.amount)
      : Decimal4.from(payment.amount);
    paymentByOrder.set(
      payment.orderId,
      (paymentByOrder.get(payment.orderId) ?? Decimal4.zero()).add(signed),
    );
  }

  const limit = Decimal4.from(tolerance);
  const failingOrderIds = orders
    .filter((order) =>
      Decimal4.from(order.netAmountIncTax)
        .subtract(paymentByOrder.get(order.orderId) ?? Decimal4.zero())
        .abs()
        .compare(limit) > 0,
    )
    .map((order) => order.orderId);

  return {
    checkId: "tender_reconciles",
    status: failingOrderIds.length === 0 ? "passed" : "failed",
    observed: `${failingOrderIds.length}/${orders.length} unreconciled orders`,
    threshold: tolerance,
    details: { failingOrderIds },
  };
}

export function checkJournalBalance(
  lines: readonly JournalLine[],
  tolerance = "0.0100",
): QualityCheckResult {
  const totals = new Map<string, { debit: Decimal4; credit: Decimal4 }>();
  for (const line of lines) {
    const current = totals.get(line.journalId) ?? {
      debit: Decimal4.zero(),
      credit: Decimal4.zero(),
    };
    totals.set(line.journalId, {
      debit: current.debit.add(line.debitAmount),
      credit: current.credit.add(line.creditAmount),
    });
  }

  const limit = Decimal4.from(tolerance);
  const failingJournalIds = [...totals.entries()]
    .filter(([, total]) => total.debit.subtract(total.credit).abs().compare(limit) > 0)
    .map(([journalId]) => journalId);

  return {
    checkId: "journal_balances",
    status: failingJournalIds.length === 0 ? "passed" : "failed",
    observed: `${failingJournalIds.length}/${totals.size} unbalanced journals`,
    threshold: tolerance,
    details: { failingJournalIds },
  };
}

export function checkObservationCoverage(
  canonicalEntityIds: readonly string[],
  observedCanonicalEntityIds: readonly string[],
  minimumCoverage = "0.9900",
): QualityCheckResult {
  const observed = new Set(observedCanonicalEntityIds);
  const missingIds = canonicalEntityIds.filter((id) => !observed.has(id));
  const coverage = canonicalEntityIds.length === 0
    ? Decimal4.from("1")
    : Decimal4.fromScaled(
      (BigInt(canonicalEntityIds.length - missingIds.length) * BigInt(10_000)) /
      BigInt(canonicalEntityIds.length),
    );
  const status = coverage.compare(minimumCoverage) >= 0 ? "passed" : "failed";

  return {
    checkId: "observation_coverage",
    status,
    observed: coverage.toString(),
    threshold: minimumCoverage,
    details: { missingIds },
  };
}

export function checkPosLedgerTolerance(
  posAmounts: readonly string[],
  ledgerAmounts: readonly string[],
  tolerance = "1.0000",
): QualityCheckResult {
  const difference = sumDecimal4(posAmounts).subtract(sumDecimal4(ledgerAmounts)).abs();
  return {
    checkId: "pos_ledger_tolerance",
    status: difference.compare(tolerance) <= 0 ? "passed" : "warning",
    observed: difference.toString(),
    threshold: tolerance,
    details: {},
  };
}
