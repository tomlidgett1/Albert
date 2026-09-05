---
user_request: >
  How much did we refund through Stripe in a period?
presentation: fact
date_parameter: stripe_refunds_analytics.created
matches:
  - "Stripe refunds last month"
  - "How much did Stripe refund this week?"
---

Succeeded Stripe refunds over created.

```json
{
  "measures": [
    "stripe_refunds_analytics.refunded_amount",
    "stripe_refunds_analytics.succeeded_refunds"
  ],
  "timeDimensions": [
    {
      "dimension": "stripe_refunds_analytics.created",
      "dateRange": "last 30 days"
    }
  ]
}
```
