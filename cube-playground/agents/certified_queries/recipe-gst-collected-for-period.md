---
user_request: >
  How much GST did we collect in a period (GST on sales at the till)?
recipe: true
presentation: fact
date_parameter: sales_analytics.completed_at
answer_hint: >
  One sentence: GST collected on sales for the period (from the POS, which is where GST collected lives).
answer_template: >
  For {{period}}, GST collected on sales was **{{sales_analytics.tax_collected|currency}}**,
  on **{{sales_analytics.gross_takings|currency}}** of gross takings.
follow_ups:
  - "How much did we sell in the same period?"
  - "What was our net profit last month?"
  - "How much did we refund last month?"
matches:
  - "How much GST did we collect last month?"
  - "GST collected last quarter"
  - "GST on sales this financial year"
---

```json
{
  "measures": [
    "sales_analytics.tax_collected",
    "sales_analytics.gross_takings"
  ],
  "timeDimensions": [
    {
      "dimension": "sales_analytics.completed_at",
      "dateRange": "last month"
    }
  ]
}
```
