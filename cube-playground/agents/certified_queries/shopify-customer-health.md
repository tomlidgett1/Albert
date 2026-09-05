---
user_request: >
  What share of my Shopify customers are repeat customers and what is their lifetime value?
---

```json
{
  "measures": [
    "shopify_customer_analytics.customer_count",
    "shopify_customer_analytics.purchasing_customers",
    "shopify_customer_analytics.repeat_customers",
    "shopify_customer_analytics.repeat_customer_rate_pct",
    "shopify_customer_analytics.average_customer_lifetime_spend"
  ],
  "dimensions": [
    "shopify_customer_analytics.shopify_shop_shop_currency"
  ]
}
```

This is an aggregate current customer-lifetime snapshot, not a cohort retention
rate. It never returns a customer row or per-customer lifetime value.
