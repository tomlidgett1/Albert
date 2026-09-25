---
user_request: >
  How much is owed to us right now (sales invoices awaiting payment, and how much of that is overdue)?
recipe: true
presentation: fact
answer_hint: >
  One or two sentences that ALWAYS state the dollar figures: "$X is owed to us across N approved invoices; $Y (M invoices) is overdue". Never give counts without the amounts.
answer_template: >
  **{{xero_finance_analytics.receivable_outstanding|currency}}** is owed to us across
  **{{xero_finance_analytics.receivable_open_count|integer}}** approved invoices;
  **{{xero_finance_analytics.receivable_overdue|currency}}**
  (**{{xero_finance_analytics.receivable_overdue_count|integer}}** invoices) is overdue.
follow_ups:
  - "Who owes us the most right now?"
  - "How much do we currently owe suppliers?"
  - "How much cash came in and went out this month?"
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
