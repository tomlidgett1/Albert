---
user_request: >
  Show Square sales per labour hour and estimated labour cost percentage by week and store.
---

```json
{
  "measures": [
    "square_labour_sales_analytics.net_sales",
    "square_labour_sales_analytics.worked_hours",
    "square_labour_sales_analytics.estimated_labour_cost",
    "square_labour_sales_analytics.sales_per_labour_hour",
    "square_labour_sales_analytics.labour_cost_pct",
    "square_labour_sales_analytics.orders_per_labour_hour"
  ],
  "dimensions": [
    "square_labour_sales_analytics.square_locations_name",
    "square_labour_sales_analytics.currency"
  ],
  "timeDimensions": [{
    "dimension": "square_labour_sales_analytics.business_date",
    "granularity": "week",
    "dateRange": "last 12 weeks"
  }]
}
```

Sales and timecards are independently aggregated to store-day before joining.
Labour cost is a wage-rate estimate, not payroll or fully loaded employment cost.
