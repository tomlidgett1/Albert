---
user_request: >
  Which customers have contributed the most gross profit?
recipe: true
presentation: table
date_parameter: sales_analytics.completed_at
answer_hint: >
  Rank attached customer profiles by gross profit for the requested period.
  Call it gross profit, never whole-business or net profit, and disclose the
  attached-customer scope without exposing contact details.
matches:
  - "Which customers are most profitable?"
  - "Which customers generate the most gross profit?"
  - "Show customer profitability"
---

Gross-profit ranking only: Lightspeed does not contain operating expenses.

```json
{
  "measures": [
    "sales_analytics.gross_takings",
    "sales_analytics.gross_profit",
    "sales_analytics.transactions"
  ],
  "dimensions": [
    "sales_analytics.customers_full_name",
    "sales_analytics.customers_company"
  ],
  "filters": [
    { "member": "sales_analytics.has_customer", "operator": "equals", "values": ["true"] }
  ],
  "order": { "sales_analytics.gross_profit": "desc" },
  "limit": 20
}
```
