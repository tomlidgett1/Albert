---
user_request: >
  How many customers do we have on file / how many have bought from us?
recipe: true
presentation: fact
answer_hint: >
  One or two sentences: customers on file, how many have purchased, repeat customers.
matches:
  - "How many customers do we have?"
  - "How many customers are on file?"
  - "How many repeat customers do we have?"
---

```json
{
  "measures": [
    "customer_analytics.customer_count",
    "customer_analytics.customers_with_purchases",
    "customer_analytics.repeat_customers"
  ]
}
```
