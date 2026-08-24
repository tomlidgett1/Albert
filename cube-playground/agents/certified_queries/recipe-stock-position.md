---
user_request: >
  Current stock on hand: value, units, and how many lines are below reorder point.
recipe: true
presentation: fact
answer_hint: >
  One or two sentences with the figure asked for; the others only if useful.
answer_template: >
  Stock on hand is **{{inventory_analytics.stock_value|currency}}** across
  **{{inventory_analytics.units_on_hand|number}} units**.
  **{{inventory_analytics.positions_below_reorder|integer}}** lines are below reorder point
  and **{{inventory_analytics.out_of_stock_positions|integer}}** are out of stock.
follow_ups:
  - "Which stock lines are below their reorder point?"
  - "What are our top products by units this month?"
  - "How much did we sell last week?"
matches:
  - "What's the total value of stock on hand right now?"
  - "How many stock lines are below their reorder point?"
  - "How much stock do we have?"
  - "What's our stock on hand?"
  - "How many items are out of stock?"
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
