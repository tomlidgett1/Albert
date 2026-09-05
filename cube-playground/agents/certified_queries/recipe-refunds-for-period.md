---
user_request: >
  How much did we refund in a period? Refund value and count.
recipe: true
presentation: fact
date_parameter: sales_analytics.completed_at
answer_hint: >
  One sentence: refund value and count for the period.
answer_template: >
  For {{period}}, refunds totalled **{{sales_analytics.refund_value|currency}}** across
  **{{sales_analytics.refund_transactions|integer}}** refund transactions.
follow_ups:
  - "How much did we sell in the same period?"
  - "How much GST did we collect last month?"
  - "What share of sales have a customer attached?"
matches:
  - "How much did we refund last month?"
  - "Refunds this year"
  - "How many refunds did we give last week?"
---

```json
{
  "measures": [
    "sales_analytics.refund_value",
    "sales_analytics.refund_transactions"
  ],
  "timeDimensions": [
    {
      "dimension": "sales_analytics.completed_at",
      "dateRange": "last month"
    }
  ]
}
```
