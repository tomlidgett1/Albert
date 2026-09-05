---
user_request: >
  Which X-Series products are out of stock or below reorder point by outlet?
---

```json
{
  "measures": [
    "lightspeed_x_inventory_analytics.current_units_on_hand",
    "lightspeed_x_inventory_analytics.current_stock_value",
    "lightspeed_x_inventory_analytics.out_of_stock_balances",
    "lightspeed_x_inventory_analytics.reorder_point_breaches"
  ],
  "dimensions": [
    "lightspeed_x_inventory_analytics.lightspeed_x_outlets_outlet_name",
    "lightspeed_x_inventory_analytics.lightspeed_x_products_product_name",
    "lightspeed_x_inventory_analytics.lightspeed_x_products_sku",
    "lightspeed_x_inventory_analytics.currency_code"
  ],
  "order": { "lightspeed_x_inventory_analytics.current_units_on_hand": "asc" },
  "limit": 100
}
```

This is current state. Never add versions over time; reorder_amount alone does
not prove a breach.

