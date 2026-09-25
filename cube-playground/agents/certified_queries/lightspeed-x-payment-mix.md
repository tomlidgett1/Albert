---
user_request: >
  What is my X-Series payment mix and refund tender flow this month?
---

```json
{
  "measures": [
    "lightspeed_x_payments_analytics.collected_amount",
    "lightspeed_x_payments_analytics.refund_tender_amount",
    "lightspeed_x_payments_analytics.net_tender_amount",
    "lightspeed_x_payments_analytics.payment_events"
  ],
  "dimensions": [
    "lightspeed_x_payments_analytics.payment_type_name",
    "lightspeed_x_payments_analytics.lightspeed_x_outlets_outlet_name",
    "lightspeed_x_payments_analytics.currency_code"
  ],
  "timeDimensions": [{
    "dimension": "lightspeed_x_payments_analytics.paid_at",
    "dateRange": "this month"
  }],
  "order": { "lightspeed_x_payments_analytics.collected_amount": "desc" }
}
```

Payments describe tender flow, not earned revenue. Positive amounts collect
value and negative amounts are reported as absolute refund tender value.

