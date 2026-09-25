---
user_request: >
  Who do we owe money to - approved unpaid bills grouped by supplier, with the overdue part?
recipe: true
presentation: table
answer_hint: >
  Lead with the total owed and how much is overdue, then name the largest suppliers; the table lists each supplier with amount owing, overdue amount and bill count, largest first.
matches:
  - "Who do we owe money to?"
  - "Which suppliers do we owe?"
  - "Who are our creditors?"
  - "What do we owe each supplier?"
  - "Accounts payable by supplier"
---

```json
{
  "measures": [
    "xero_finance_analytics.total_amount_due",
    "xero_finance_analytics.overdue_amount",
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
        "AUTHORISED"
      ]
    },
    {
      "member": "xero_finance_analytics.total_amount_due",
      "operator": "gt",
      "values": [
        "0"
      ]
    }
  ],
  "order": {
    "xero_finance_analytics.total_amount_due": "desc"
  },
  "limit": 100
}
```
