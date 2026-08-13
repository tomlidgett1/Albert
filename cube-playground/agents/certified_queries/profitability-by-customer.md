---
user_request: >
  Break down profitability by customer. Who are the most and least profitable
  customers?
---

Period-scoped: add a timeDimension dateRange on completed_at when the user
names a period.

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
  "limit": 25
}
```
