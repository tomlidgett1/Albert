---
user_request: >
  The most recent pay runs (last N payroll runs) with periods, payment dates, status and totals.
recipe: true
presentation: table
date_parameter: xero_payroll_analytics.pay_run_paid_on
empty_answer: >
  no pay runs are recorded in the payroll data yet
answer_hint: >
  Table of the most recent pay runs (period start/end, payment date, state, gross wages, tax, super, net pay), newest first, limited to the N asked for (default 10); one sentence naming the latest run and its net pay. DRAFT runs are not yet finalised - say so if any appear.
matches:
  - "Give me the last 10 payruns"
  - "Show me recent pay runs"
  - "When was the last pay run?"
  - "List the payroll runs this year"
  - "What did the last pay run cost?"
---

```json
{
  "measures": [
    "xero_payroll_analytics.pay_run_wages",
    "xero_payroll_analytics.pay_run_tax",
    "xero_payroll_analytics.pay_run_super",
    "xero_payroll_analytics.pay_run_net_pay",
    "xero_payroll_analytics.pay_run_payroll_cost"
  ],
  "dimensions": [
    "xero_payroll_analytics.pay_run_period_start",
    "xero_payroll_analytics.pay_run_period_end",
    "xero_payroll_analytics.pay_run_paid_on",
    "xero_payroll_analytics.pay_run_state"
  ],
  "order": {
    "xero_payroll_analytics.pay_run_paid_on": "desc"
  },
  "limit": 10
}
```
