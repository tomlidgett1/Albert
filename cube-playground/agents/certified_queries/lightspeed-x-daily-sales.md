---
user_request: >
  How are my Lightspeed X-Series outlets trading day by day over the last 30 days?
---

```json
{
  "measures": [
    "lightspeed_x_sales_analytics.net_sales_including_tax",
    "lightspeed_x_sales_analytics.closed_sales",
    "lightspeed_x_sales_analytics.returns_including_tax",
    "lightspeed_x_sales_analytics.average_closed_sale_value"
  ],
  "dimensions": [
    "lightspeed_x_sales_analytics.lightspeed_x_outlets_outlet_name",
    "lightspeed_x_sales_analytics.currency_code"
  ],
  "timeDimensions": [{
    "dimension": "lightspeed_x_sales_analytics.sold_at",
    "granularity": "day",
    "dateRange": "last 30 days"
  }],
  "order": { "lightspeed_x_sales_analytics.sold_at": "asc" }
}
```

Net sales are signed tax-inclusive closed-sale value after returns and exclude
gift-card loads. Parked, pending and voided totals do not contribute.

