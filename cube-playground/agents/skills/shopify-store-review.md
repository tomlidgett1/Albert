---
title: Shopify store review
description: >
  Use when the user asks for a Shopify store review or a diagnosis spanning
  sales, product, payment, refund, fulfilment and inventory performance.
---

# Shopify store review

1. Query monthly current sales, orders and AOV by currency from
   `shopify_sales_analytics` and call out test/cancelled-order exclusions.
2. Query product sales separately for units, net product sales and discount
   concentration by safe non-authored classifications. Merchant-authored
   product/SKU labels are unavailable in replayable public results. Do not
   reconcile line totals to order totals without caveats.
3. Query payment success/gateway mix, refund lines, return lifecycle and
   fulfilment delivery performance as separate facts.
4. Check inventory risk by stock state, keeping inventory states separate;
   merchant-authored product/SKU/location labels are unavailable publicly.
5. Explain the reporting time, currencies, original-vs-current semantics and
   any scope/protected-field gaps before recommendations.
