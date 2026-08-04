# ADR 0066: Lightspeed calculated sale components

- Status: Accepted
- Date: 2026-08-05
- Owners: Albert platform
- Related: ADR 0029 (quarantine and replay), ADR 0064 (record-scoped
  canonical reference isolation), Albert v1 sections 11, 17, and 18

## Context

The full Lightspeed backfill failed `line_maths` for most order lines and
`tender_reconciles` for thousands of orders even though source extraction was
complete.  This was a canonical interpretation defect, not bad source data.

Lightspeed defines `normalUnitPrice` as the item price before price rules and
`discountAmount` as a configured dollar-discount input.  The applied values
are `calcLineDiscount` plus `calcTransactionDiscount`; `calcTotal` is the line
total.  The mapper used `normalUnitPrice * unitQuantity` as gross and ignored
percentage and transaction discount allocations.  It also projected archived
SalePayment attempts as captured tenders.

The source represents refunds as negative-quantity SaleLines.  Excluding those
lines from the source order made exchange and refund headers impossible to
reconcile even though a separate positive-magnitude refund fact was correctly
published for operational sales.

## Decision

1. Map line discount from the signed sum of `calcLineDiscount` and
   `calcTransactionDiscount`, with `discountAmount` only as a compatibility
   fallback for older recordings that omit calculated fields.
2. Map line net from `calcTotal`, tax from `calcTax1 + calcTax2`, and arithmetic
   gross as net plus applied discount.  Never use `normalUnitPrice` as the
   realised line gross.
3. Preserve every signed SaleLine on its source order so source lines reconcile
   the header.  Negative lines use `order_status='refunded'`, so the governed
   sales event excludes them and continues to publish their separate
   `commerce_refund_line` event without double-counting.
4. Map the order header from Lightspeed's calculated header fields, including
   refunds, with the same signed arithmetic.
5. Project archived SalePayment attempts as voided tombstones.  Reconcile
   completed orders against the signed sum of captured and refunded live
   tenders; voided attempts never enter the sum.

## Validation

On the live dogfood source, all 48,264 completed, non-voided sales reconciled:
the sum of line `calcTotal` matched the header total, calculated line discounts
matched `calcDiscount`, calculated line taxes matched the header tax, and the
sum of non-archived payment amounts matched both total and `calcPayments`.
There were 3,807 archived payment attempts across 3,290 sales; including them
created every source-level tender mismatch, while excluding them produced zero.

## Consequences

- Full replay repairs historical line, order, and payment facts deterministically.
- Discounts and sell-price realisation use applied values rather than list-price
  or configuration proxies.
- Refunds remain positive-magnitude refund facts for sales analytics and signed
  tender facts for settlement, with no duplicate sales event.
