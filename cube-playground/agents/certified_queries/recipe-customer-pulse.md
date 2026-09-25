---
user_request: >
  Give me a quick pulse check on the customer base.
recipe: true
presentation: fact
answer_hint: >
  Summarise active profiles, purchasing profiles, repeat customers, repeat rate,
  signed lifetime net spend and refunds. Do not call lifetime repeat rate cohort
  retention, and do not infer a cause or marketing consent.
answer_template: >
  You have **{{customer_analytics.active_customer_count|integer}} active customer profiles**.
  **{{customer_analytics.customers_with_purchases|integer}}** have made a positive purchase and
  **{{customer_analytics.repeat_customers|integer}}** have bought more than once, a
  **{{customer_analytics.repeat_purchase_rate_pct|percent}} lifetime repeat-purchase rate**.
  Signed lifetime net spend is **{{customer_analytics.total_lifetime_net_spend|currency}}** after
  **{{customer_analytics.total_lifetime_refund_value|currency}}** in attributed refunds. These are
  POS profiles, not deduplicated people.
follow_ups:
  - "Who are our top customers by lifetime net spend?"
  - "Which high-value customers have not purchased in 180 days?"
  - "What share of sales have a customer attached?"
matches:
  - "How are our customers doing?"
  - "Give me a customer pulse check"
  - "How healthy is our customer base?"
---

```json
{
  "measures": [
    "customer_analytics.active_customer_count",
    "customer_analytics.customers_with_purchases",
    "customer_analytics.repeat_customers",
    "customer_analytics.repeat_purchase_rate_pct",
    "customer_analytics.total_lifetime_net_spend",
    "customer_analytics.total_lifetime_refund_value"
  ]
}
```
