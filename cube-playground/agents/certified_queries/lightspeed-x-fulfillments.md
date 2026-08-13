---
user_request: >
  What X-Series fulfilment units remain to be completed by product and state?
---

```json
{
  "measures": [
    "lightspeed_x_fulfillment_analytics.required_units",
    "lightspeed_x_fulfillment_analytics.picked_units",
    "lightspeed_x_fulfillment_analytics.packed_units",
    "lightspeed_x_fulfillment_analytics.fulfilled_units",
    "lightspeed_x_fulfillment_analytics.remaining_units"
  ],
  "dimensions": [
    "lightspeed_x_fulfillment_analytics.lightspeed_x_fulfillments_fulfillment_type",
    "lightspeed_x_fulfillment_analytics.lightspeed_x_fulfillments_fulfillment_state",
    "lightspeed_x_fulfillment_analytics.lightspeed_x_products_product_name",
    "lightspeed_x_fulfillment_analytics.lightspeed_x_products_sku"
  ],
  "order": { "lightspeed_x_fulfillment_analytics.remaining_units": "desc" }
}
```

Line quantities and state are current snapshots. Transition timing requires the
history stream through the source explorer.

