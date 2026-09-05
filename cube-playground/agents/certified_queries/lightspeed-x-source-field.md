---
user_request: >
  Show the exact value returned for a documented X-Series field that has no curated member.
---

```json
{
  "measures": [
    "lightspeed_x_source_explorer.field_occurrences",
    "lightspeed_x_source_explorer.source_records"
  ],
  "dimensions": [
    "lightspeed_x_source_explorer.source_record_id",
    "lightspeed_x_source_explorer.value_type",
    "lightspeed_x_source_explorer.string_value",
    "lightspeed_x_source_explorer.number_value",
    "lightspeed_x_source_explorer.boolean_value",
    "lightspeed_x_source_explorer.timestamp_value",
    "lightspeed_x_source_explorer.date_value",
    "lightspeed_x_source_explorer.json_value"
  ],
  "filters": [
    { "member": "lightspeed_x_source_explorer.parent_stream", "operator": "equals", "values": ["lx_channels"] },
    { "member": "lightspeed_x_source_explorer.field_path", "operator": "equals", "values": ["name"] }
  ],
  "limit": 100
}
```

Replace both filters with the one exact requested stream and documented path.
Select only the typed value matching value_type; numeric values are not
automatically additive and source text may contain PII.

