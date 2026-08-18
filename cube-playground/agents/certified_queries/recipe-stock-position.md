---
user_request: >
  Current stock on hand: value, units, and how many lines are below reorder point.
recipe: true
presentation: fact
answer_hint: >
  One or two sentences with the figure asked for; the others only if useful.
matches:
  - "What's the total value of stock on hand right now?"
  - "How many stock lines are below their reorder point?"
  - "How much stock do we have?"
---

```json
{
  "measures": [
    "inventory_analytics.stock_value",
    "inventory_analytics.units_on_hand",
    "inventory_analytics.positions_below_reorder",
    "inventory_analytics.out_of_stock_positions"
  ]
}
```
