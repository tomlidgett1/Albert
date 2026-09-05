---
user_request: >
  Show Shopify sales, orders and average order value by month for the last 12 months.
---

```json
{
  "measures": [
    "shopify_sales_analytics.current_total_sales",
    "shopify_sales_analytics.orders",
    "shopify_sales_analytics.average_order_value",
    "shopify_sales_analytics.distinct_protected_subjects"
  ],
  "dimensions": ["shopify_sales_analytics.currency_code"],
  "timeDimensions": [{
    "dimension": "shopify_sales_analytics.processed_at",
    "granularity": "month",
    "dateRange": "last 12 months"
  }]
}
```
