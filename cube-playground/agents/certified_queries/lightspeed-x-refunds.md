---
user_request: >
  Show realised X-Series refunds and average time to return by outlet this quarter.
---

```json
{
  "measures": [
    "lightspeed_x_refunds_analytics.refund_value_including_tax",
    "lightspeed_x_refunds_analytics.closed_returns",
    "lightspeed_x_refunds_analytics.average_refund_value",
    "lightspeed_x_refunds_analytics.average_days_to_return"
  ],
  "dimensions": [
    "lightspeed_x_refunds_analytics.lightspeed_x_outlets_outlet_name",
    "lightspeed_x_refunds_analytics.currency_code"
  ],
  "timeDimensions": [{
    "dimension": "lightspeed_x_refunds_analytics.returned_at",
    "dateRange": "this quarter"
  }]
}
```

Only closed return sales are realised. Product allocation belongs in product
sales filtered to return lines; refund destination belongs in payments.

