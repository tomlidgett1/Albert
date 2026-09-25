---
user_request: >
  Which X-Series products generated the most realised gross profit this quarter?
---

```json
{
  "measures": [
    "lightspeed_x_product_sales_analytics.net_product_sales_excluding_tax",
    "lightspeed_x_product_sales_analytics.net_cost_of_goods",
    "lightspeed_x_product_sales_analytics.gross_profit_before_sale_level_discount",
    "lightspeed_x_product_sales_analytics.net_units"
  ],
  "dimensions": [
    "lightspeed_x_product_sales_analytics.lightspeed_x_products_product_name",
    "lightspeed_x_product_sales_analytics.lightspeed_x_products_variant_name",
    "lightspeed_x_product_sales_analytics.lightspeed_x_products_sku",
    "lightspeed_x_product_sales_analytics.currency_code"
  ],
  "timeDimensions": [{
    "dimension": "lightspeed_x_product_sales_analytics.sold_at",
    "dateRange": "this quarter"
  }],
  "order": { "lightspeed_x_product_sales_analytics.gross_profit_before_sale_level_discount": "desc" },
  "limit": 50
}
```

Realised cost comes from the sale line. Sale-level discount-product value is not
allocated to ordinary products and should be reported separately when material.

