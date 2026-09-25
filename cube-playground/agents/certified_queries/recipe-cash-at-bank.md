---
user_request: >
  How much is in the bank right now (current total bank, cash at bank, Balance in Xero)?
recipe: true
presentation: fact
answer_hint: >
  One sentence: Xero's Total Bank line for the current report month.
answer_template: >
  Total bank in Xero is **{{xero_balance_sheet_analytics.total_bank|currency}}**.
follow_ups:
  - "How much cash came in and went out this month?"
  - "How much is owed to us right now?"
  - "How much do we currently owe suppliers?"
matches:
  - "How much is in the bank right now?"
  - "What's our bank balance?"
  - "How much cash do we have in the bank?"
  - "Total bank in Xero"
  - "What is the balance in Xero?"
---

Headline Total Bank for the current report month only. Never sum across months.
For cash in and out over a period use recipe-bank-money-for-period.

```json
{
  "measures": [
    "xero_balance_sheet_analytics.total_bank"
  ],
  "filters": [
    {
      "member": "xero_balance_sheet_analytics.is_current_period",
      "operator": "equals",
      "values": [
        "true"
      ]
    }
  ]
}
```
