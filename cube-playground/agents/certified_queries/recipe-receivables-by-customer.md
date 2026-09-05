---
user_request: >
  Who owes us money - approved unpaid sales invoices grouped by customer, with the overdue part?
recipe: true
presentation: table
answer_hint: >
  Lead with the total owed to us and the overdue part, then name the customers; the table lists each customer with amount owing, overdue amount and invoice count, largest first.
matches:
  - "Who owes us money?"
  - "Which customers owe us?"
  - "Who are our debtors?"
  - "Which customer owes us money and is it overdue?"
  - "Accounts receivable by customer"
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
        "Sales invoice"
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
