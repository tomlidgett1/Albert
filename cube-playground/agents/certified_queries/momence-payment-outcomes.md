---
user_request: >
  How much did Momence capture, refund and charge in fees by currency this month?
---

```json
{
  "measures": [
    "momence_payment_analytics.discovered_payment_transactions",
    "momence_payment_analytics.succeeded_payment_transactions",
    "momence_payment_analytics.failed_payment_transactions",
    "momence_payment_analytics.captured_currency_amount",
    "momence_payment_analytics.refunded_currency_amount",
    "momence_payment_analytics.net_captured_currency_after_refunds",
    "momence_payment_analytics.host_covered_processor_fees",
    "momence_payment_analytics.host_covered_platform_fees"
  ],
  "dimensions": [
    "momence_payment_analytics.currency_code",
    "momence_payment_analytics.payment_status"
  ],
  "timeDimensions": [{
    "dimension": "momence_payment_analytics.created_at",
    "dateRange": "this month"
  }],
  "order": {"momence_payment_analytics.captured_currency_amount": "desc"}
}
```

Coverage is partial because detailed payment IDs are discoverable only from
member notes. Do not call these totals a complete processor reconciliation.

