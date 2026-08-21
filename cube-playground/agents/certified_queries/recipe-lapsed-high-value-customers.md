---
user_request: >
  Which previously valuable customers have not made a positive purchase for more than 180 days?
recipe: true
presentation: table
answer_hint: >
  Rank active customer profiles whose latest positive purchase is over 180
  elapsed days old by signed lifetime net spend. "Lapsed" is this fixed recency
  rule, not a churn prediction. Do not claim they consented to contact.
matches:
  - "Which high-value customers are lapsed?"
  - "Who should we consider winning back?"
  - "Which valuable customers have not returned in 180 days?"
---

```json
{
  "dimensions": [
    "customer_analytics.full_name",
    "customer_analytics.company",
    "customer_analytics.lifetime_net_spend",
    "customer_analytics.purchase_count",
    "customer_analytics.refund_count",
    "customer_analytics.last_purchase_at",
    "customer_analytics.recency_band"
  ],
  "segments": [
    "customer_analytics.active_customers",
    "customer_analytics.lapsed_180_days"
  ],
  "order": { "customer_analytics.lifetime_net_spend": "desc" },
  "limit": 25
}
```
