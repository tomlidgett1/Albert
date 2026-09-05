---
user_request: >
  How is my Square loyalty program being used over the last 90 days?
---

```json
{
  "measures": [
    "square_loyalty_activity_analytics.loyalty_events",
    "square_loyalty_activity_analytics.points_net_change",
    "square_loyalty_activity_analytics.points_earned",
    "square_loyalty_activity_analytics.points_expired",
    "square_loyalty_activity_analytics.rewards_created",
    "square_loyalty_activity_analytics.rewards_redeemed"
  ],
  "dimensions": ["square_loyalty_activity_analytics.event_type"],
  "timeDimensions": [{
    "dimension": "square_loyalty_activity_analytics.created_at",
    "granularity": "week",
    "dateRange": "last 90 days"
  }]
}
```

This is event flow. Current outstanding point balance belongs in
square_loyalty_analytics and must not be summed over time.
