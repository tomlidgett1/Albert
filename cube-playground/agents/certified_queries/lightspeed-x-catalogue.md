---
user_request: >
  Summarise my active X-Series catalogue by category, brand and inventory tracking.
---

```json
{
  "measures": [
    "lightspeed_x_catalogue_analytics.active_products_and_variants",
    "lightspeed_x_catalogue_analytics.sellable_variants",
    "lightspeed_x_catalogue_analytics.inventory_tracked_products",
    "lightspeed_x_catalogue_analytics.average_retail_price_including_tax"
  ],
  "dimensions": [
    "lightspeed_x_catalogue_analytics.lightspeed_x_product_categories_category_name",
    "lightspeed_x_catalogue_analytics.lightspeed_x_brands_brand_name"
  ]
}
```

Catalogue prices and supply costs are current configuration, not realised sale
price or cost.

