---
user_request: >
  Which Shopify discounts are active and how much usage and attributed sales do they have?
---

```json
{
  "measures": [
    "shopify_discount_analytics.discount_definitions",
    "shopify_discount_analytics.discount_uses",
    "shopify_discount_analytics.attributed_discount_sales",
    "shopify_discount_analytics.average_sales_per_use",
    "shopify_discount_analytics.remaining_usage_capacity"
  ],
  "dimensions": [
    "shopify_discount_analytics.discount_type",
    "shopify_discount_analytics.lifecycle",
    "shopify_discount_analytics.discount_classes",
    "shopify_discount_analytics.shopify_shop_shop_currency"
  ],
  "order": {"shopify_discount_analytics.attributed_discount_sales": "desc"},
  "limit": 25
}
```

Attributed sales is Shopify's value for sales associated with the definition;
it is not the amount discounted. Merchant-authored discount titles/codes are
not available on the replayable public surface.
