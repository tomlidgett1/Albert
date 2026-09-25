---
user_request: >
  How many active Stripe subscriptions do we have?
presentation: fact
matches:
  - "Active Stripe subscriptions"
  - "How many Stripe subscribers?"
---

Current subscription headcount, not recognised revenue.

```json
{
  "measures": [
    "stripe_subscriptions_analytics.active_subscriptions",
    "stripe_subscriptions_analytics.subscription_count"
  ],
  "dimensions": [
    "stripe_subscriptions_analytics.status"
  ]
}
```
