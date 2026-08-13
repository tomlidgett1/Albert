---
user_request: >
  Which X-Series promotions were applied most often over the last 90 days?
---

```json
{
  "measures": [
    "lightspeed_x_promotion_analytics.promotion_applications",
    "lightspeed_x_promotion_analytics.promotion_discount_value",
    "lightspeed_x_promotion_analytics.promotion_affected_sales",
    "lightspeed_x_promotion_analytics.promotion_affected_lines"
  ],
  "dimensions": [
    "lightspeed_x_promotion_analytics.applied_promotion_name",
    "lightspeed_x_promotion_analytics.promo_code"
  ],
  "timeDimensions": [{
    "dimension": "lightspeed_x_promotion_analytics.sold_at",
    "dateRange": "last 90 days"
  }],
  "order": { "lightspeed_x_promotion_analytics.promotion_discount_value": "desc" }
}
```

One line can have multiple promotions, so the curated application grain does
not expose duplicated attributed revenue.

