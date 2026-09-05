---
user_request: >
  How many bills came in each month and what were they worth (supplier bills by month)?
recipe: true
presentation: line
date_parameter: xero_finance_analytics.issued_on
answer_hint: >
  Line chart of bill value by month (or the single figure if one month was asked).
matches:
  - "How many bills came in each month this year and what were they worth?"
  - "Show me monthly bills from suppliers this year as a chart"
  - "How many bills did we receive last month?"
---

```json
{
  "measures": [
    "xero_finance_analytics.invoice_count",
    "xero_finance_analytics.total_invoiced"
  ],
  "filters": [
    {
      "member": "xero_finance_analytics.document_kind",
      "operator": "equals",
      "values": [
        "Bill"
      ]
    },
    {
      "member": "xero_finance_analytics.invoice_status",
      "operator": "equals",
      "values": [
        "AUTHORISED",
        "PAID"
      ]
    }
  ],
  "timeDimensions": [
    {
      "dimension": "xero_finance_analytics.issued_on",
      "granularity": "month",
      "dateRange": "this year"
    }
  ]
}
```
