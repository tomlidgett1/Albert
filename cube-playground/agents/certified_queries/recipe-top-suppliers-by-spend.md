---
user_request: >
  Which suppliers have we spent the most with (bills by supplier) for a period?
recipe: true
presentation: table
date_parameter: xero_finance_analytics.issued_on
answer_hint: >
  Name the top supplier first, then the table (supplier, spend incl. GST, bills). For one named supplier, filter invoice_contact with contains on the name.
matches:
  - "Which suppliers have we spent the most with this financial year?"
  - "Top suppliers this year"
  - "How much have we bought from Pon Bike this year?"
  - "What did we spend with our top 5 suppliers last financial year?"
---

```json
{
  "measures": [
    "xero_finance_analytics.total_invoiced",
    "xero_finance_analytics.invoice_count"
  ],
  "dimensions": [
    "xero_finance_analytics.invoice_contact"
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
      "dateRange": "this year"
    }
  ],
  "order": {
    "xero_finance_analytics.total_invoiced": "desc"
  },
  "limit": 10
}
```
