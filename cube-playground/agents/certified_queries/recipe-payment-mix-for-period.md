---
user_request: >
  How much did we take by card versus cash (payment types / tender mix) for a period?
recipe: true
presentation: table
date_parameter: payments_analytics.completed_at
answer_hint: >
  Table of payment type, amount, count; one sentence with the card and cash figures.
matches:
  - "How much did we take by card versus cash last month?"
  - "Payment mix this year"
  - "Cash vs card split"
---

```json
{
  "measures": [
    "payments_analytics.tender_total",
    "payments_analytics.payment_count"
  ],
  "dimensions": [
    "payments_analytics.payment_types_name"
  ],
  "timeDimensions": [
    {
      "dimension": "payments_analytics.completed_at",
      "dateRange": "last month"
    }
  ],
  "order": {
    "payments_analytics.tender_total": "desc"
  },
  "limit": 12
}
```
