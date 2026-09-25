---
user_request: >
  Which X-Series product price-book rules are currently configured?
---

```json
{
  "measures": [
    "lightspeed_x_pricing_analytics.price_book_product_rules",
    "lightspeed_x_pricing_analytics.average_price_book_price",
    "lightspeed_x_pricing_analytics.minimum_price_book_price",
    "lightspeed_x_pricing_analytics.maximum_price_book_price"
  ],
  "dimensions": [
    "lightspeed_x_pricing_analytics.lightspeed_x_price_books_price_book_name",
    "lightspeed_x_pricing_analytics.lightspeed_x_products_product_name",
    "lightspeed_x_pricing_analytics.lightspeed_x_products_sku",
    "lightspeed_x_pricing_analytics.adjustment_type"
  ],
  "limit": 100
}
```

Rule prices are configuration snapshots. Eligibility still depends on book
dates, platform, outlet, customer group and quantity thresholds.

