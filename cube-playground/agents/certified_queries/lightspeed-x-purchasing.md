---
user_request: >
  Which X-Series supplier-order lines still have units outstanding?
---

```json
{
  "measures": [
    "lightspeed_x_purchasing_analytics.ordered_units",
    "lightspeed_x_purchasing_analytics.received_units",
    "lightspeed_x_purchasing_analytics.outstanding_units",
    "lightspeed_x_purchasing_analytics.ordered_cost"
  ],
  "dimensions": [
    "lightspeed_x_purchasing_analytics.lightspeed_x_consignments_consignment_name",
    "lightspeed_x_purchasing_analytics.lightspeed_x_consignments_consignment_status",
    "lightspeed_x_purchasing_analytics.line_supplier_name",
    "lightspeed_x_purchasing_analytics.lightspeed_x_products_sku"
  ],
  "order": { "lightspeed_x_purchasing_analytics.outstanding_units": "desc" },
  "limit": 100
}
```

Ordered cost is operational stock-order value, not an accounting supplier bill
or cash payment.

