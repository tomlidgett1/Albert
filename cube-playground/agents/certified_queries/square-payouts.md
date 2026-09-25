---
user_request: >
  Which Square payouts reached my bank in the last 30 days, by store?
---

```json
{
  "measures": [
    "square_settlements_analytics.paid_payout_amount",
    "square_settlements_analytics.paid_payouts"
  ],
  "dimensions": [
    "square_settlements_analytics.square_locations_name",
    "square_settlements_analytics.destination_type",
    "square_settlements_analytics.end_to_end_id",
    "square_settlements_analytics.currency"
  ],
  "timeDimensions": [{
    "dimension": "square_settlements_analytics.arrival_date",
    "granularity": "day",
    "dateRange": "last 30 days"
  }],
  "order": { "square_settlements_analytics.arrival_date": "desc" }
}
```

Payouts are settlement transfers, not sales or bank-feed transactions.
