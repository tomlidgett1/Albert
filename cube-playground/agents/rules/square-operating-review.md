---
type: agent_requested
description: >
  Method for a broad Square cafe or retail performance review covering sales,
  menu/item mix, payments and fees, refunds, inventory, labour, cash drawers,
  settlements and loyalty without mixing grains.
---

# Square operating review

Run independent, same-period branches and combine only in the narrative:

1. Trading: net order value, completed orders, average order, returns,
   discounts, tax, tips and service charges from `square_sales_analytics`.
2. Menu/product mix: units and final line value by category/item from
   `square_product_sales_analytics`; say that itemised return quantities are not
   netted on this surface.
3. Acceptance cost: completed collections by payment method, then a separate
   fee-grain query from `square_payments_analytics`. Compare fees to completed
   collections only after both totals are retrieved.
4. Refund quality: completed refund value/count and top reasons from
   `square_refunds_analytics`. Do not attribute payment-only refunds to products.
   Review open dispute exposure/due dates separately in `square_disputes_analytics`.
5. Stock: current IN_STOCK quantity and estimated-balance flags from
   `square_inventory_analytics`; investigate adjustments/waste using
   `square_inventory_activity_analytics` separately.
6. Labour: sales, worked hours, estimated labour cost and sales per labour hour
   from `square_labour_sales_analytics`. Label labour cost as an estimate.
7. Till control: closed-drawer expected, counted and variance from
   `square_cash_management_analytics`; rank material shortages separately from overs.
8. Settlement: PAID payout amount/date from `square_settlements_analytics`;
   inspect payout entries in a separate query when the transfer does not reconcile.
9. Loyalty: membership/current point balance from `square_loyalty_analytics`,
   then earned/expired/reward events from `square_loyalty_activity_analytics`.
10. Stored value: current gift-card balance from `square_gift_card_analytics`
    and activity counts separately; never treat loads as revenue.

Use one complete comparison period and the immediately preceding equivalent
period. Rank findings by monetary or operational impact, distinguish facts from
inferences, and suggest only actions supported by the retrieved evidence.
