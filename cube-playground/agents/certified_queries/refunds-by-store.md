---
user_request: >
  Where are refunds happening? Refund value and rate by store.
---

```json
{
  "measures": [
    "sales_analytics.refund_transactions",
    "sales_analytics.refund_value",
    "sales_analytics.transactions",
    "sales_analytics.gross_takings"
  ],
  "dimensions": ["sales_analytics.shops_name"],
  "order": { "sales_analytics.refund_value": "desc" }
}
```
