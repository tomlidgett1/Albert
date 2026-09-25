---
user_request: >
  How many customers do we have on file / how many have bought from us?
recipe: true
presentation: fact
answer_hint: >
  One or two sentences: active profiles, how many have made a positive purchase,
  repeat customers and the repeat-purchase rate. Profiles are not deduplicated people.
answer_template: >
  There are **{{customer_analytics.customer_count|integer}} customer profiles** on file,
  including **{{customer_analytics.active_customer_count|integer}} active profiles**.
  **{{customer_analytics.customers_with_purchases|integer}}** have made a positive purchase and
  **{{customer_analytics.repeat_customers|integer}}** have bought more than once, a
  **{{customer_analytics.repeat_purchase_rate_pct|percent}} lifetime repeat-purchase rate**.
  Profiles are not deduplicated people.
follow_ups:
  - "Give me a quick pulse check on the customer base."
  - "Who are our top customers by lifetime net spend?"
  - "What share of sales have a customer attached?"
matches:
  - "How many customers do we have?"
  - "How many customers are on file?"
  - "How many repeat customers do we have?"
---

```json
{
  "measures": [
    "customer_analytics.customer_count",
    "customer_analytics.active_customer_count",
    "customer_analytics.customers_with_purchases",
    "customer_analytics.repeat_customers",
    "customer_analytics.repeat_purchase_rate_pct"
  ]
}
```
