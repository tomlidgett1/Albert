---
user_request: >
  How much did we sell yesterday / today / last week / last month / this month / on a given date? Total sales or takings for one period.
recipe: true
presentation: fact
date_parameter: sales_analytics.completed_at
answer_hint: >
  One or two sentences: the takings for the period (GST inclusive), transactions if useful. No exclusions or source notes.
answer_template: >
  For {{period}}, gross takings were **{{sales_analytics.gross_takings|currency}}**
  across **{{sales_analytics.transactions|integer}}** transactions, averaging
  **{{sales_analytics.average_sale_value|currency}}** per sale.
matches:
  - "Show me sales this week"
  - "What were sales this week?"
  - "What were my sales yesterday?"
  - "How much did we sell last week?"
  - "What were total sales last month?"
  - "Sales so far this month?"
  - "What were sales on 15 August 2026?"
  - "How many sales did we make today?"
  - "What's our average sale this week?"
  - "How many transactions today?"
  - "What was AOV yesterday?"
  - "Show me sales and transactions this week"
  - "What were yesterday's takings?"
  - "What were today's takings?"
  - "What were last week's takings?"
follow_ups:
  - "How did this week compare with last week?"
  - "How much did we refund for the same period?"
  - "How much GST did we collect this week?"
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
