---
user_request: >
  How much do we currently owe suppliers (bills awaiting payment, and how much of that is overdue)?
recipe: true
presentation: fact
answer_hint: >
  One or two sentences that ALWAYS state the dollar figures: "we owe $X across N approved bills awaiting payment; $Y (M bills) is overdue"; add the draft bills value only if non-zero, as "not yet approved". Never give counts without the amounts.
answer_template: >
  We owe **{{xero_finance_analytics.payable_outstanding|currency}}** across
  **{{xero_finance_analytics.payable_open_count|integer}}** approved bills awaiting payment;
  **{{xero_finance_analytics.payable_overdue|currency}}**
  (**{{xero_finance_analytics.payable_overdue_count|integer}}** bills) is overdue.
  Draft bills not yet approved total **{{xero_finance_analytics.draft_bills_total|currency}}**
  (**{{xero_finance_analytics.draft_bill_count|integer}}**).
follow_ups:
  - "Which bills are overdue?"
  - "How much is owed to us right now?"
  - "What did we spend with suppliers last month?"
matches:
  - "How much do we currently owe suppliers?"
  - "What do we owe in total?"
  - "How much is outstanding to suppliers?"
  - "What do we owe to suppliers right now?"
  - "Bills to pay"
  - "How much do we have in unpaid bills?"
  - "How many unpaid bills do we have?"
---

```json
{
  "measures": [
    "xero_finance_analytics.payable_outstanding",
    "xero_finance_analytics.payable_open_count",
    "xero_finance_analytics.payable_overdue",
    "xero_finance_analytics.payable_overdue_count",
    "xero_finance_analytics.draft_bills_total",
    "xero_finance_analytics.draft_bill_count"
  ]
}
```
