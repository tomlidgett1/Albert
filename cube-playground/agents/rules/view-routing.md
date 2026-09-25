---
type: always
---

# Choosing the right view

- One query stays within one view. To combine perspectives, run one query per
  view and join the findings in the answer.
- sales_analytics: whole transactions. Revenue, refunds, tax, discounts,
  quotes, voids, stores, staff, and the customer attached to each sale.
- product_sales_analytics: line items. Anything about products, categories,
  brands, units, item-level margin. Line revenue across all items slightly
  exceeds header revenue on split/discounted sales; prefer sales_analytics for
  headline revenue totals.
- payments_analytics: tenders. Payment types, tips, card charges, processing
  fees. Tender totals include change and on-account payments, so they are not
  a substitute for revenue.
- customer_analytics: one row per customer. Lifetime behaviour, geography,
  contactability, store credit. For "top customers by spend in period X",
  prefer sales_analytics grouped by customer instead of lifetime members.
