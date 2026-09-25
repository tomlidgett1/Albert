---
user_request: >
  What is my current Square gift-card balance and how many active cards do I have?
---

```json
{
  "measures": [
    "square_gift_card_analytics.outstanding_gift_card_balance",
    "square_gift_card_analytics.active_gift_cards",
    "square_gift_card_analytics.gift_cards"
  ],
  "dimensions": [
    "square_gift_card_analytics.state",
    "square_gift_card_analytics.card_type",
    "square_gift_card_analytics.currency"
  ]
}
```

Outstanding gift-card value is a current liability-like snapshot, not revenue
and not additive over time.
