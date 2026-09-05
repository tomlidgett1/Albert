---
user_request: >
  What Stripe invoices are still outstanding?
presentation: fact
matches:
  - "Outstanding Stripe invoices"
  - "Unpaid Stripe invoices"
---

Open or uncollectible remaining amounts. Do not mix with charge collections.

```json
{
  "measures": [
    "stripe_billing_analytics.amount_remaining",
    "stripe_billing_analytics.open_invoices",
    "stripe_billing_analytics.invoice_count"
  ],
  "dimensions": [
    "stripe_billing_analytics.status"
  ]
}
```
