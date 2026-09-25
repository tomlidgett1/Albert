---
user_request: >
  What payment methods appear on Momence sales in the last 30 days?
---

```json
{
  "measures": [
    "momence_sale_tender_analytics.tender_items",
    "momence_sale_tender_analytics.tender_amount_ex_tax",
    "momence_sale_tender_analytics.tender_tax",
    "momence_sale_tender_analytics.tender_amount_inc_tax"
  ],
  "dimensions": [
    "momence_sale_tender_analytics.payment_method_type",
    "momence_sale_tender_analytics.payment_method_name",
    "momence_sale_tender_analytics.currency_availability"
  ],
  "timeDimensions": [{
    "dimension": "momence_sale_tender_analytics.sale_at",
    "dateRange": "last 30 days"
  }],
  "order": {"momence_sale_tender_analytics.tender_items": "desc"}
}
```

HostSale tender items omit currency and status. This describes source tender mix,
not complete/certified captured cash.

