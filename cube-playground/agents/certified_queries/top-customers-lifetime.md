---
user_request: >
  Who are our best customers of all time by lifetime spend?
recipe: true
presentation: table
answer_hint: >
  Present the highest signed lifetime net spend first, with positive purchase
  count, refund count and last positive purchase. State that customer profiles
  may contain duplicate records for one person; do not expose contact details.
matches:
  - "Who are our best customers of all time?"
  - "Who are our top customers by lifetime spend?"
  - "Which customers have spent the most with us?"
---

```json
{
  "dimensions": [
    "customer_analytics.full_name",
    "customer_analytics.company",
    "customer_analytics.lifetime_net_spend",
    "customer_analytics.purchase_count",
    "customer_analytics.refund_count",
    "customer_analytics.last_purchase_at"
  ],
  "filters": [
    { "member": "customer_analytics.purchase_count", "operator": "gt", "values": ["0"] }
  ],
  "order": { "customer_analytics.lifetime_net_spend": "desc" },
  "limit": 20
}
```
