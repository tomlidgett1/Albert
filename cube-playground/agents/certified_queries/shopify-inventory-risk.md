---
user_request: >
  How much Shopify inventory is out of stock or below safety stock?
---

```json
{
  "measures": [
    "shopify_inventory_analytics.inventory_positions",
    "shopify_inventory_analytics.available_units",
    "shopify_inventory_analytics.units_on_hand"
  ],
  "dimensions": [
    "shopify_inventory_analytics.stock_state"
  ],
  "filters": [{
    "member": "shopify_inventory_analytics.stock_state",
    "operator": "equals",
    "values": ["Out of stock", "Low stock", "Oversold"]
  }],
  "order": {"shopify_inventory_analytics.available_units": "asc"}
}
```
