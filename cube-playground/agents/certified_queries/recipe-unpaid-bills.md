---
user_request: >
  List our unpaid (approved but not yet paid) supplier bills, with due dates and what is overdue.
recipe: true
presentation: table
answer_hint: >
  Lead with what is already overdue (count and total), then the bills due in the asked window; table of supplier, number, due date, amount, days overdue. Flag implausible due dates (e.g. 1954) as data quirks.
empty_answer: >
  there are no approved bills awaiting payment - nothing is unpaid or overdue
matches:
  - "How many unpaid bills do we have?"
  - "Which bills are overdue?"
  - "What's the oldest overdue bill?"
  - "List the bills that are due in the next 14 days"
  - "What bills are due in September?"
---

```json
{
  "measures": [
    "xero_finance_analytics.total_amount_due"
  ],
  "dimensions": [
    "xero_finance_analytics.invoice_contact",
    "xero_finance_analytics.invoice_number",
    "xero_finance_analytics.issued_on",
    "xero_finance_analytics.due_on",
    "xero_finance_analytics.days_overdue"
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
    }
  ],
  "order": {
    "xero_finance_analytics.due_on": "asc"
  },
  "limit": 100
}
```
