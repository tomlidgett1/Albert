---
title: Square weekly operating review
description: >
  Use when a Square cafe or retailer asks for a weekly wrap, store health check,
  or a broad review of sales, menu mix, payments, labour, stock and cash control.
---

# Square weekly operating review

Use the last complete local Monday-Sunday week and the preceding complete week.
Run separate Cube queries at each native grain:

1. `square_sales_analytics`: net order value, completed orders, average order,
   returns, discounts, tips and service charges, daily and by store.
2. `square_product_sales_analytics`: top/bottom categories and items by final
   line value and units. Disclose that itemised return quantities are not netted.
3. `square_payments_analytics`: collections and tips by payment method; run a
   separate fee-grain query for processing fees.
4. `square_refunds_analytics`: completed refund value/count and top reasons.
5. `square_labour_sales_analytics`: worked hours, estimated labour cost, sales
   per labour hour and labour cost percentage by store/day.
6. `square_inventory_analytics`: current IN_STOCK quantity and zero/estimated
   positions. Current stock has no weekly time comparison.
7. `square_cash_management_analytics`: closed drawer shortages/overs.
8. `square_settlements_analytics`: PAID payout arrivals; investigate entries in
   a separate query only when a payout needs explanation.

Structure the response as: headline and comparison, daily/store shape, item/menu
mix, payments/refunds, labour efficiency, current stock exceptions, cash and
settlement exceptions, then at most three evidence-backed actions. Label sales
as tax-inclusive net completed order value. Label labour cost as a wage-rate
estimate rather than payroll. Never combine measures from incompatible grains
in one Cube query.

