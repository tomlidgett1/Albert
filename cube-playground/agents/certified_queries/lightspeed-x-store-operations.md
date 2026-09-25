---
user_request: >
  Which X-Series registers are currently open?
---

```json
{
  "measures": [
    "lightspeed_x_store_operations_analytics.registers",
    "lightspeed_x_store_operations_analytics.open_registers"
  ],
  "dimensions": [
    "lightspeed_x_store_operations_analytics.register_name",
    "lightspeed_x_store_operations_analytics.lightspeed_x_outlets_outlet_name",
    "lightspeed_x_store_operations_analytics.is_open"
  ]
}
```

Register state is operational POS state. X-Series till-login shifts are not
rosters, payroll or fully loaded labour cost.

