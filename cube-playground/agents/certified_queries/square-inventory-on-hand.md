---
user_request: >
  What Square stock is on hand now, and which items have no stock by store?
---

```json
{
  "measures": [
    "square_inventory_analytics.units_in_stock",
    "square_inventory_analytics.stocked_variations",
    "square_inventory_analytics.estimated_balances"
  ],
  "dimensions": [
    "square_inventory_analytics.square_locations_name",
    "square_inventory_analytics.square_catalog_objects_object_name",
    "square_inventory_analytics.square_catalog_objects_sku",
    "square_inventory_analytics.is_estimated"
  ],
  "segments": [],
  "order": { "square_inventory_analytics.units_in_stock": "asc" },
  "limit": 100
}
```

This is a current state balance. Do not add a time range or sum snapshots over time.

