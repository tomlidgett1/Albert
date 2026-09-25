---
user_request: >
  How many X-Series customers are repeat buyers and what is their lifetime spend?
---

```json
{
  "measures": [
    "lightspeed_x_customer_analytics.customers_with_purchases",
    "lightspeed_x_customer_analytics.repeat_customers",
    "lightspeed_x_customer_analytics.repeat_customer_rate_pct",
    "lightspeed_x_customer_analytics.total_lifetime_net_spend"
  ],
  "dimensions": [
    "lightspeed_x_customer_analytics.lightspeed_x_customer_groups_customer_group_name",
    "lightspeed_x_customer_analytics.currency_code"
  ]
}
```

Lifetime spend uses attributed closed sales, subtracts returns and excludes
gift-card load liabilities. It is not a period measure.

