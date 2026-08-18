---
user_request: >
  How much did we sell yesterday / today / last week / last month / this month / on a given date? Total sales for one period.
recipe: true
presentation: fact
date_parameter: sales_analytics.completed_at
answer_hint: >
  One or two sentences: the takings for the period (GST inclusive), transactions if useful. No exclusions or source notes.
matches:
  - "What were my sales yesterday?"
  - "How much did we sell last week?"
  - "What were total sales last month?"
  - "Sales so far this month?"
  - "What were sales on 15 August 2026?"
  - "How many sales did we make today?"
---

Lightspeed is the canonical sales source. Set the dateRange from the owner's period; the default is yesterday.

```json
{
  "measures": [
    "sales_analytics.gross_takings",
    "sales_analytics.transactions",
    "sales_analytics.average_sale_value"
  ],
  "timeDimensions": [
    {
      "dimension": "sales_analytics.completed_at",
      "dateRange": "yesterday"
    }
  ]
}
```
