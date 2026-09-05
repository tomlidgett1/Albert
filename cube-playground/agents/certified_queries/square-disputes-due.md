---
user_request: >
  Which Square disputes need attention, how much is exposed and when is evidence due?
---

```json
{
  "measures": [
    "square_disputes_analytics.dispute_amount",
    "square_disputes_analytics.disputes",
    "square_disputes_analytics.response_due_disputes",
    "square_disputes_analytics.overdue_response_disputes"
  ],
  "dimensions": [
    "square_disputes_analytics.state",
    "square_disputes_analytics.reason",
    "square_disputes_analytics.currency",
    "square_disputes_analytics.due_at",
    "square_disputes_analytics.square_locations_name"
  ],
  "order": { "square_disputes_analytics.due_at": "asc" },
  "limit": 100
}
```

Dispute amount is exposure, not automatically a realised expense or refund.
