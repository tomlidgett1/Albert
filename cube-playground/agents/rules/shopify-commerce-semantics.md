---
type: always
---

# Shopify commerce semantics

- For Shopify headline sales use `shopify_sales_analytics.current_total_sales`
  over `processed_at`. It is the latest order state after edits, refunds and
  returns. Use `original_total_sales` only when the user explicitly asks for
  order-time/original value. Use `processed_at` only as a `timeDimensions`
  member with `day` or coarser granularity.
- Original/current merchandise values, discounts and tax are separate semantic
  families. Label which family was used; never mix them in one unlabeled total.
- Refund money and refunded units come from `shopify_refunds_analytics` (or the
  order's source-reported `refunded_amount` for order incidence). Never infer a
  refund by subtracting current from original order value.
- Exclude test and cancelled/voided orders from default sales measures. Their
  dedicated counts remain available for operational questions.
- `displayFinancialStatus` and `displayFulfillmentStatus` are categorical state,
  not evidence of bank settlement or physical delivery beyond their definitions.
- Currency amounts are exact decimals. Group/filter by `currency_code` whenever
  multiple currencies may be present; never sum unlike currencies.
- Commerce, payment, refund, fulfilment, return and customer views are
  aggregate-only. Never request a row-level amount or an individual source
  identifier, and never describe these data-minimised aggregates as anonymous.
