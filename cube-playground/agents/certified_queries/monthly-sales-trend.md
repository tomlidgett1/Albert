---
user_request: >
  How are sales trending? Show revenue and transactions by month for the last
  12 months.
---

```json
{
  "measures": [
    "sales_analytics.gross_takings",
    "sales_analytics.net_sales_ex_tax",
    "sales_analytics.transactions",
    "sales_analytics.average_sale_value"
  ],
  "timeDimensions": [
    {
      "dimension": "sales_analytics.completed_at",
      "granularity": "month",
      "dateRange": "last 12 months"
    }
  ]
}
```
