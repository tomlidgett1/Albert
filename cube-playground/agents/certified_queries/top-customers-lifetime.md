---
user_request: >
  Who are our best customers of all time by lifetime spend?
---

```json
{
  "dimensions": [
    "customer_analytics.full_name",
    "customer_analytics.company",
    "customer_analytics.lifetime_revenue",
    "customer_analytics.lifetime_transactions",
    "customer_analytics.last_purchase_at"
  ],
  "order": { "customer_analytics.lifetime_revenue": "desc" },
  "limit": 20
}
```
