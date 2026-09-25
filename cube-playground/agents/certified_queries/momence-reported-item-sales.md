---
user_request: >
  What kinds of things did we sell through Momence over the last 30 days?
---

```json
{
  "measures": [
    "momence_product_sales_analytics.sale_item_rows",
    "momence_product_sales_analytics.reported_quantity",
    "momence_product_sales_analytics.reported_line_value_ex_tax",
    "momence_product_sales_analytics.reported_line_tax",
    "momence_product_sales_analytics.reported_line_value_inc_tax",
    "momence_product_sales_analytics.reported_line_discount_ex_tax"
  ],
  "dimensions": [
    "momence_product_sales_analytics.item_type",
    "momence_product_sales_analytics.item_name",
    "momence_product_sales_analytics.currency_availability"
  ],
  "timeDimensions": [{
    "dimension": "momence_product_sales_analytics.sale_at",
    "dateRange": "last 30 days"
  }],
  "order": {"momence_product_sales_analytics.reported_line_value_inc_tax": "desc"},
  "limit": 50
}
```

HostSale is experimental and returns neither currency nor lifecycle status.
These are reported source values, not certified revenue.

