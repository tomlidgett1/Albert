# Square semantic model playbook

The curated CubeCore surface follows Square's native grains and lifecycle
semantics. It does not treat every monetary object as revenue.

| Question | View | Business time | Governing measure/state |
| --- | --- | --- | --- |
| Sales / takings / average order | `square_sales_analytics` | `closed_at` | `net_order_value`, COMPLETED orders |
| Item, menu, variation, category | `square_product_sales_analytics` | `completed_at` | `total_line_value`, completed non-gift-card lines |
| Tender/payment mix | `square_payments_analytics` | `created_at` | `collected_amount`, COMPLETED payments |
| Processing fees | `square_payments_analytics` | `square_payment_fees_effective_at` | `square_payment_fees_processing_fees` at fee grain |
| Refunds | `square_refunds_analytics` | `completed_at` | `refund_value`, COMPLETED refunds |
| Deposits / settlements | `square_settlements_analytics` | `arrival_date` | `paid_payout_amount`, PAID payouts |
| Current stock | `square_inventory_analytics` | latest `calculated_at` | `units_in_stock`, state IN_STOCK |
| Stock changes | `square_inventory_activity_analytics` | `occurred_at` | state transition and absolute units affected |
| Hours and current clock-ins | `square_workforce_analytics` | `start_at` | completed/open timecards |
| Labour efficiency | `square_labour_sales_analytics` | `business_date` | store-day pre-aggregated ratios |
| Cash over/short | `square_cash_management_analytics` | `closed_at` | counted minus expected, CLOSED drawer |
| Loyalty balance/events | loyalty views | account update / event time | snapshot balance versus signed events |

Money remains paired with currency and is converted using ISO 4217 exponents.
Order revenue is tax-inclusive and includes tips and service charges. Payments
are collections, refunds are separate money-out events, payouts are settlement,
and gift-card issuance/load is stored-value liability rather than earned sales.

The curated surface never makes these unsafe mappings:

- payout to bank-feed transaction;
- PaymentRefund to a product refund line without allocation evidence;
- Timecard to planned shift;
- V1/Transactions overlap to a second copy of modern Order revenue;
- invoice backed by an existing order to a second sale;
- inventory state to a time-additive balance.

## Canonical versus Square-specific

| Square evidence | Canonical model | Square extension retained |
| --- | --- | --- |
| Merchant / Location | legal entity, location, stock location | profile, capability and address detail |
| Customer / TeamMember | person, customer account, worker/employment identity | preferences, mappings, assignment and custom fields |
| CatalogObject | product, variation, category, tax code, supplier where applicable | all Square object subtypes, options, modifiers and custom attributes |
| Order / line item | commerce order and order line | fulfilment, pricing, metadata, applied tax/discount/service-charge detail |
| Payment / processing fee | commerce payment and payment fee | method-specific, risk, offline, device and exchange detail |
| PaymentRefund | commerce refund | destination and processor detail; never fabricated line allocation |
| Inventory count/change | inventory balance snapshot and movement | Square inventory state, reason/group and transfer detail |
| Timecard / scheduled shift | workforce time entry / planned shift | breaks, wage/job snapshot and Square workflow detail |
| Payout / payout entry | finance settlement and settlement line | processor activity subtype and destination detail |
| Dispute, cash drawer, gift card, loyalty, booking, subscription | governed Square extension | full native object and every indexed field |

Canonical facts support source-neutral and cross-connector questions. The
Square-specific views and exhaustive explorer remain available for native
detail; canonical promotion is never allowed to erase source evidence.
