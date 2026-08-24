---
user_request: >
  How much did Stripe take in fees, and what was net, over a period?
presentation: fact
date_parameter: stripe_balance_analytics.created
matches:
  - "Stripe processing fees last month"
  - "Stripe net and fees this week"
---

Balance-transaction grain. reporting_category can be added for a breakdown.

```json
{
  "measures": [
    "stripe_balance_analytics.fee_amount",
    "stripe_balance_analytics.net_amount",
    "stripe_balance_analytics.gross_amount"
  ],
  "timeDimensions": [
    {
      "dimension": "stripe_balance_analytics.created",
      "dateRange": "last 30 days"
    }
  ]
}
```
