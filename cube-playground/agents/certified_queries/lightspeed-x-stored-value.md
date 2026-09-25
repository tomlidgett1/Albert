---
user_request: >
  What is the current outstanding X-Series gift-card liability?
---

```json
{
  "measures": [
    "lightspeed_x_stored_value_analytics.current_gift_card_liability",
    "lightspeed_x_stored_value_analytics.active_gift_cards",
    "lightspeed_x_stored_value_analytics.gift_cards"
  ],
  "dimensions": [
    "lightspeed_x_stored_value_analytics.gift_card_currency",
    "lightspeed_x_stored_value_analytics.gift_card_status"
  ]
}
```

This is one current account snapshot. Do not trend or sum it over ingestion
versions, and do not treat loads or balances as earned revenue.

