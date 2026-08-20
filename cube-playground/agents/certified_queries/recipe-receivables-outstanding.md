---
user_request: >
  How much is owed to us right now (sales invoices awaiting payment, and how much of that is overdue)?
recipe: true
presentation: fact
answer_hint: >
  One or two sentences that ALWAYS state the dollar figures: "$X is owed to us across N approved invoices; $Y (M invoices) is overdue". Never give counts without the amounts.
matches:
  - "How much is owed to us right now?"
  - "How much money is owed to us?"
  - "Outstanding invoices"
  - "How much is owed to us by customers?"
  - "Invoices owed to us"
  - "What are our receivables?"
---

```json
{
  "measures": [
    "xero_finance_analytics.receivable_outstanding",
    "xero_finance_analytics.receivable_open_count",
    "xero_finance_analytics.receivable_overdue",
    "xero_finance_analytics.receivable_overdue_count"
  ]
}
```
