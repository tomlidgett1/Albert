---
type: always
---

# Refunds, voids and sale state

- Revenue measures already exclude voided sales and count only completed
  transactions. Refunds are completed sales with a negative total; they are
  included in revenue as negatives, so "sales" figures are net of refunds.
- `refund_value` is reported as a positive dollar amount of money returned.
- Voided sales (`voided_transactions`, `sale_voids_*` members) never count as
  revenue or refunds. If a question is about mistakes or cancellations, use
  void members, not refunds.
- Open tickets (`open_tickets`, `open_sales` segment) are not revenue until
  completed. Do not include them in sales totals.
