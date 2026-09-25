---
user_request: >
  What share of sales transactions and takings have a customer profile attached?
recipe: true
presentation: fact
date_parameter: sales_analytics.completed_at
answer_hint: >
  Report identified and anonymous transactions/takings for the same period and
  their coverage percentages. Explain that unattributed sales cannot support
  customer-level conclusions; do not treat one anonymous bucket as a customer.
answer_template: >
  For the requested period, **{{sales_analytics.identified_transactions|integer}}** of
  **{{sales_analytics.transactions|integer}}** completed transactions had a customer profile attached
  (**{{sales_analytics.identified_transaction_coverage_pct|percent}}**). Those identified sales
  represented **{{sales_analytics.identified_gross_takings|currency}}** of
  **{{sales_analytics.gross_takings|currency}}** in takings
  (**{{sales_analytics.identified_revenue_coverage_pct|percent}}**); the remaining
  **{{sales_analytics.anonymous_gross_takings|currency}}** cannot support customer-level conclusions.
follow_ups:
  - "How has customer attribution coverage changed by month?"
  - "Which customer segments contribute the most takings?"
  - "Give me a quick pulse check on the customer base."
matches:
  - "What share of sales have a customer attached?"
  - "How good is our customer attribution coverage?"
  - "How much revenue is anonymous versus identified?"
---

```json
{
  "measures": [
    "sales_analytics.transactions",
    "sales_analytics.identified_transactions",
    "sales_analytics.anonymous_transactions",
    "sales_analytics.identified_transaction_coverage_pct",
    "sales_analytics.gross_takings",
    "sales_analytics.identified_gross_takings",
    "sales_analytics.anonymous_gross_takings",
    "sales_analytics.identified_revenue_coverage_pct"
  ],
  "timeDimensions": [
    { "dimension": "sales_analytics.completed_at", "dateRange": "last 12 months" }
  ]
}
```
