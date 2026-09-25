---
user_request: >
  How did sales go this month compared to the same month last year?
  Year-over-year month comparison.
---

Replace the two ranges with the current month and the same month last year.

```json
{
  "measures": [
    "sales_analytics.gross_takings",
    "sales_analytics.transactions",
    "sales_analytics.gross_profit"
  ],
  "timeDimensions": [
    {
      "dimension": "sales_analytics.completed_at",
      "compareDateRange": [
        "2026-08-01,2026-08-31",
        "2025-08-01,2025-08-31"
      ]
    }
  ]
}
```
