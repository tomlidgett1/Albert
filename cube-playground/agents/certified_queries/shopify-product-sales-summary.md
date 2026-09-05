---
user_request: >
  Summarise Shopify product sales by shipping and tax treatment in the last 30 days.
---

```json
{
  "measures": [
    "shopify_product_sales_analytics.units_ordered",
    "shopify_product_sales_analytics.net_product_sales_before_returns",
    "shopify_product_sales_analytics.line_discounts",
    "shopify_product_sales_analytics.distinct_protected_subjects"
  ],
  "dimensions": [
    "shopify_product_sales_analytics.requires_shipping",
    "shopify_product_sales_analytics.taxable",
    "shopify_product_sales_analytics.shopify_orders_currency_code"
  ],
  "timeDimensions": [{
    "dimension": "shopify_product_sales_analytics.shopify_orders_processed_at",
    "granularity": "day",
    "dateRange": "last 30 days"
  }],
  "order": {"shopify_product_sales_analytics.net_product_sales_before_returns": "desc"},
  "limit": 20
}
```

Merchant-authored product/variant/SKU/vendor labels and exact order-line records
are unavailable on this replayable surface. Every group represents at least
five protected subjects.
