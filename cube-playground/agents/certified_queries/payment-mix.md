---
user_request: >
  What is our payment mix? Takings by payment type, including tips.
---

```json
{
  "measures": [
    "payments_analytics.tender_total",
    "payments_analytics.payment_count",
    "payments_analytics.tips_total",
    "payments_analytics.average_payment_amount"
  ],
  "dimensions": ["payments_analytics.payment_types_name"],
  "order": { "payments_analytics.tender_total": "desc" }
}
```
