---
user_request: >
  What are my best-selling Square items and categories this month?
---

```json
{
  "measures": [
    "square_product_sales_analytics.units_sold",
    "square_product_sales_analytics.total_line_value",
    "square_product_sales_analytics.line_discounts"
  ],
  "dimensions": [
    "square_product_sales_analytics.category_name",
    "square_product_sales_analytics.item_name",
    "square_product_sales_analytics.variation_name",
    "square_product_sales_analytics.currency"
  ],
  "timeDimensions": [{
    "dimension": "square_product_sales_analytics.completed_at",
    "dateRange": "this month"
  }],
  "order": { "square_product_sales_analytics.total_line_value": "desc" },
  "limit": 25
}
```

Gift-card load lines are excluded. The product-line surface does not subtract
nested itemised return quantities, so use Square sales/refunds for headline net revenue.
