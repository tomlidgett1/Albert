---
type: always
---

# Shopify view routing

- One query stays inside one view. Query multiple views separately and reconcile
  narratively; do not create fan-out joins across facts.
- Orders/revenue/AOV/status: `shopify_sales_analytics`.
- Aggregate units/line discounts by non-authored classifications:
  `shopify_product_sales_analytics`. Product/SKU labels are unavailable here.
- Gateway/capture/authorisation/payment failures: `shopify_payments_analytics`.
- Refund dollars/units/restocking: `shopify_refunds_analytics`.
- Dispatch/delivery/service timing: `shopify_fulfillment_analytics`.
- Return lifecycle/exchanges: `shopify_returns_analytics`.
- Current stock states: `shopify_inventory_analytics`; product/SKU/location
  labels and identifiers are unavailable here.
- Customer snapshots: `shopify_customer_analytics`; product/variant definitions:
  `shopify_catalogue_analytics` / `shopify_variant_analytics`.
- Discount definitions: `shopify_discount_analytics`; shop setup:
  `shopify_store_analytics`.
- Only for a specifically named source field absent above, use
  `shopify_source_fields_analytics` to explain its definition and availability.
  It contains no merchant value; an allowed current value uses the typed live
  Admin read plane and otherwise remains explicitly Unavailable.
