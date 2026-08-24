---
user_request: >
  How much did Stripe collect yesterday / this week / last month? Succeeded charge collections for one period.
presentation: fact
date_parameter: stripe_payments_analytics.created
answer_hint: >
  One or two sentences: succeeded collected amount and charge count for the period.
matches:
  - "How much did Stripe collect last month?"
  - "Stripe charges this week"
  - "What were succeeded Stripe payments yesterday?"
---

Stripe Charge grain. Only succeeded paid charges contribute to collected_amount.

```json
{
  "measures": [
    "stripe_payments_analytics.collected_amount",
    "stripe_payments_analytics.succeeded_charges",
    "stripe_payments_analytics.average_charge"
  ],
  "timeDimensions": [
    {
      "dimension": "stripe_payments_analytics.created",
      "dateRange": "yesterday"
    }
  ]
}
```
