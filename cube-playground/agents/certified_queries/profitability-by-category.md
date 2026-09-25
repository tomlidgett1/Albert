---
user_request: >
  Break down profitability by category. Which categories make or lose the most
  gross profit?
---

```json
{
  "measures": [
    "product_sales_analytics.line_revenue",
    "product_sales_analytics.line_cost_of_goods",
    "product_sales_analytics.line_gross_profit",
    "product_sales_analytics.line_gross_margin_pct",
    "product_sales_analytics.units_sold"
  ],
  "dimensions": ["product_sales_analytics.categories_full_path_name"],
  "order": { "product_sales_analytics.line_gross_profit": "desc" },
  "limit": 25
}
```
