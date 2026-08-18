# Fivetran schema coverage of the Cube semantic layer

> **Superseded for Xero (2026-08-17):** the standard Fivetran Xero connector is
> replaced by Albert's own Fivetran Connector SDK connector
> (`connectors/xero-fivetran-sdk/`, see its README). It takes a single Xero
> consent in Albert, lands Albert's `source_xero.*` table shapes (all 197 spec
> tables incl. AU/UK/NZ payroll) plus `xero_report_*` line tables (P&L, balance
> sheet, trial balance, bank/executive/budget summaries) into `xero_<id>`, so
> the Xero payroll and reports gaps below no longer apply and the `xo_*` views
> port across with a schema re-point only.
>
> **Superseded for Lightspeed R-Series (2026-08-17):** the standard
> `light_speed_retail` connector (Connect Card, ~80% coverage) is likewise
> replaced by Albert's own Connector SDK connector
> (`connectors/lightspeed-fivetran-sdk/`, see its README). One Lightspeed
> consent in Albert; the connector lands **all 90 `ls_*` tables in the exact
> `source_lightspeed.ls_*` staging shape** (tips, inventory logs, shipments,
> vendor returns, processing fees included) into `lightspeed_<id>`.
> Migration 0171 builds `source_lightspeed_fivetran.ls_*` (UNION ALL over the
> bound schemas, Fivetran's identifier rewrite undone via the connector's
> `albert_column_contract` table) and the Cube-facing
> `source_lightspeed_official.ls_*` views (envelope: `tenant_id`,
> `namespaced_source_key`, `source_record_id`, `source_updated_at`,
> `tombstone`, `mapping_version = 'fivetran-sdk'`, `ingested_at`), and the
> Cube models now read `source_lightspeed_official.ls_*`. The Lightspeed gap
> table below no longer applies. Deputy section stands.

Assessed 2026-08-17 against:

- **Cube read surface** — every `sql:` in `cube-playground/model/cubes/*.yml`
  (views carry no SQL), resolved through the `xo_*` (0164), `dp_*` (0134) and
  `ls_*` (0121) view/table definitions to the underlying source columns.
- **Fivetran** — Xero: the schema Fivetran actually landed for the live
  connection (`xero_01m070svg…`, 33 tables) plus Fivetran's ERD and its
  enabled/disabled table list for that connection; Lightspeed Retail
  (`light_speed_retail`) and Deputy: Fivetran's published interactive ERDs
  (`fivetran.com/connector-erd/<service>`).

Verdict in one line: **Xero accounting is fully covered, Xero payroll is
mostly not; Deputy is covered except leave-rule names; Lightspeed R-Series is
~80% covered with a handful of real gaps (tips, inventory logs, shipments,
vendor returns, processing fees).** In every case a mapping layer is needed,
because the cubes read Albert's `xo_*`/`dp_*`/`ls_*` names with envelope
columns (`tenant_id`, `row_key`, `tombstone`, `namespaced_source_key`), while
Fivetran writes native names into one schema per connection.

Legend: ✅ available (possibly via join) · ◐ partial · ❌ not in Fivetran.

---

## Structural note (applies to all three)

| Cube expects | Fivetran gives | What must be built |
|---|---|---|
| `source_xero_official.xo_*` / `source_deputy.dp_*` / `source_lightspeed.ls_*` | `xero_<conn>.invoice`, `deputy_<conn>.resource_timesheet`, `lightspeed_<conn>.sale_history` … | Re-point each `xo_*`/`dp_*`/`ls_*` view at the Fivetran tables (UNION ALL across tenant schemas, or one view set per tenant schema). |
| `tenant_id` on every row | `tenant_id` **is stamped** onto every Fivetran table by `ingestion.stamp_fivetran_destination` (0166/0167) with RLS | Nothing extra. |
| `row_key` / `namespaced_source_key` | Fivetran primary keys (`invoice_id`, `(line_item_id, invoice_id)`, `(id, updated_time)`) | Synthesise in the view (`tenant_id \|\| ':' \|\| pk`). |
| `tombstone` (soft delete) | `_fivetran_deleted` where the connector captures deletes (Xero: account, bank_transaction, contact, invoice, manual_journal, payment; Lightspeed: `archived`; Deputy: none) | Map to `_fivetran_deleted`/`archived`, else `false`. |
| Lightspeed: current state per record | Lightspeed tables with `update_time` are delivered as **`*_history`** rows keyed `(id, updated_time)` | Views must pick the latest `updated_time` per `id` (or use Fivetran's current-state twin if it is created — confirm on first sync). |

---

## 1. Xero — Fivetran service `xero`

### 1a. Accounting & reference (xero_accounting.yml, xero_reference.yml) — **covered**

| Cube view | Fivetran table(s) | Status / notes |
|---|---|---|
| xo_organisation | organization | ✅ all fields incl. edition, tax_number, FY end, lock dates |
| xo_accounts | account | ✅ |
| xo_contacts | contact | ◐ balances ✅ (`balances_accounts_*`); **payment terms (sales/bills day+type) not in Fivetran** |
| xo_contact_addresses / phones | contact_address, contact_phone | ✅ |
| xo_items | item | ✅ (`sales_details_*`, `purchase_details_*` flattened) |
| xo_tax_rates, xo_currencies, xo_users | tax_rate, currency, user | ✅ |
| xo_branding_themes | branding_theme | ◐ no `type` column |
| xo_budgets | — | ❌ Fivetran Xero has no budgets |
| xo_invoices | invoice | ✅ |
| xo_invoice_line_items | invoice_line_item ⋈ invoice ⋈ item | ✅ (`item_name` via item.name) |
| xo_payments | payment ⋈ invoice ⋈ contact | ✅ (`batch_payment_id` flattened on payment) |
| xo_credit_notes / line items | credit_note, credit_note_line_item | ✅ |
| xo_credit_note_allocations, xo_overpayment_allocations | allocation | ✅ (single table keyed by credit_note_id / overpayment_id / prepayment_id) |
| xo_bank_transactions / line items | bank_transaction ⋈ bank_account, bank_transaction_line_items | ✅ |
| xo_bank_transfers | bank_transfer ⋈ bank_account | ◐ no `from_is_reconciled` / `to_is_reconciled` |
| xo_batch_payments, xo_batch_payment_members | derived from payment.`batch_payment_*` (+ bank_transaction) | ◐ Fivetran has no batch_payment table; id/date/type/status/total/is_reconciled are flattened onto payment; **`details` missing** |
| xo_manual_journals / lines | manual_journal, manual_journal_line | ✅ (debit/credit totals derivable from lines) |
| xo_overpayments | overpayment ⋈ contact | ✅ |
| xo_repeating_invoices / line items | repeating_invoice(+line_item) | ✅ (`schedule_*` flattened) |
| xo_assets, xo_asset_types | asset, asset_type | ✅ (`depreciation_*` flattened) |
| xo_files, xo_file_associations | — | ❌ Fivetran Xero has no Files API tables |
| xo_pnl_lines, xo_gst_lines (derived) | invoice_line_item + bank_transaction_line_items + manual_journal_line ⋈ account | ✅ derivable exactly as today |

Bonus available from Fivetran that Albert does not model yet: `tracking_category(_option)` and the `*_has_tracking_category` join tables, `purchase_order(_line_item)`, `prepayment(_line_item)`, `contact_group(_member)`, `bank_linked_transactions`, `invoice_linked_transactions`.

**General ledger caveat (important):** Fivetran's `journal` / `journal_line` / `journal_cash*` tables — the true GL — are **disabled on the live connection: "We do not have required permissions to access this table"** (also `employee`, `expense_claim`, `receipt*`). The org is on Xero `ULTIMATE_10`, so it is not the plan; the Fivetran-requested `accounting.journals.read` scope did not make it into the grant. Today's `xo_pnl_lines` reconstructs P&L from documents and manual journals, so nothing breaks — but if the semantic layer is ever moved to journal-based P&L/balance sheet, this must be resolved with Fivetran/Xero first (re-authorise and confirm the consent screen lists Journals).

### 1b. AU payroll (xero_payroll.yml) — **mostly NOT covered**

Fivetran Xero only carries `aus_payroll_employee`, `aus_payroll_timesheet(_line)`, `aus_payroll_leave_application(_period)`.

| Cube view | Fivetran | Status |
|---|---|---|
| xo_payroll_employees | aus_payroll_employee | ◐ names/status/email/DOB/start/rate+calendar ids ✅; **no** gender, job_title, classification, employment_type, income_type, approves_leave/timesheets, tax declaration, home address |
| xo_payroll_timesheets | aus_payroll_timesheet | ✅ |
| xo_timesheet_day_units | aus_payroll_timesheet_line | ◐ `earnings_rate_id`, `number_of_units` present; per-day (`worked_on`) breakdown depends on how Fivetran flattens the units array — verify on first payroll sync |
| xo_pay_runs | — | ❌ |
| xo_payslip_summaries | — | ❌ |
| xo_earnings_rates, xo_deduction_types, xo_leave_types, xo_reimbursement_types | — | ❌ |
| xo_payroll_calendars, xo_super_funds, xo_super_memberships | — | ❌ |
| xo_employee_pay_template_earnings, xo_payroll_settings_accounts | — | ❌ |

10 of the 14 payroll cubes have no Fivetran source. Payroll *cost* still reaches the GL as manual journals / bank transactions (which Fivetran does carry), so P&L wage lines survive; the payroll-detail cubes (pay runs, payslips, super, leave balances) do not. Options: keep Albert's own Xero payroll extraction alongside Fivetran for these endpoints, or drop the payroll cubes.

---

## 2. Deputy — Fivetran service `deputy` — **covered (one small gap)**

| Cube view | Fivetran table(s) | Status |
|---|---|---|
| dp_employees | employee ⋈ employee_history (via `history_id`): display_name, first/last, position, active, start_date, termination_date, role_id, company_id | ✅ |
| dp_employee_roles | employee_role (`role`, `ranking`) | ✅ |
| dp_operational_units | operational_unit ⋈ company (`company_name`) | ✅ (`address_id` → address for city/state) |
| dp_timesheets | resource_timesheet: id, employee_id, date, start/end_time_localized, total_time, cost, on_cost, time_approved, pay_rule_approved, is_in_progress, is_leave, leave_id, leave_rule_id, operational_unit, discarded; names via employee_history / operational_unit joins | ✅ (`_DPMetaData__*` display names replaced by joins) |
| dp_rosters | roster: id, employee_id, date, start/end_time_localized, total_time, cost, published, opens, matched_by_timesheet, operational_unit_id, comment, confirm_status | ✅ |
| dp_leave | employee_leave: id, employee_id, company_id, date_start/end, days, total_hours, status, leave_rule_id, comment, approval_comment | ✅ |
| dp_leave_rules | — | ❌ Fivetran has no leave-rule dimension (`leave_rule_id` appears on employee_leave / resource_timesheet / contract_leave_rule, but no `name` / `paid_leave`) |

Extra Fivetran tables Albert doesn't use yet: `timesheet_pay_retrun` (pay-rule cost breakdown per timesheet), `contract_pay_rule`, `employee_agreement`, `pay_period`, `company_period`, `award_library`, `employee_availability`, `roster_slot` / `timesheet_slot` (breaks).

---

## 3. Lightspeed Retail R-Series — Fivetran service `light_speed_retail` — **~80% covered**

### Covered
| Cube table | Fivetran table | Notes |
|---|---|---|
| ls_sales | sale_history | ✅ totals, calc_*, completed/voided, complete_time, tax rates, ticket/reference — **but no tips** (see gaps) |
| ls_sale_lines | sale_line_history | ✅ (`calculated_line_discount` = calc_line_discount); no `line_type`, `item_fee_id`, `require_full_reservation` |
| ls_sale_payments | sale_payment | ✅ except `tip_amount`; `shop_id` via sale |
| ls_payment_types, ls_sale_voids, ls_quotes | payment_type, sale_void, quote | ✅ |
| ls_discounts | discount_history | ✅ (`source_id` missing) |
| ls_cc_charges | cc_charge_history | ✅ (`response` missing) |
| ls_items | item_history ⋈ item_price ⋈ category_history | ✅ core fields; no dimensions (h/w/l/weight), `list_on_store`, e-commerce short/long description |
| ls_categories, ls_manufacturers | category_history, manufacturer_history | ✅ |
| ls_tags | item_tag / item_tag_history | ✅ (tag text) |
| ls_item_prices, ls_price_levels | item_price(+history), price_level | ✅ |
| ls_customers | customer_history | ✅ (contact fields inline; `contact_id` link absent) |
| ls_customer_types | customer_type | ✅ |
| ls_contacts / emails / phones | contact_history, customer_email_history, customer_phone_history | ✅ (re-key by customer_id) |
| ls_credit_accounts | credit_account_history | ✅ |
| ls_ship_tos | ship_to_history | ✅ (`shipped` missing) |
| ls_item_shops | item_shop_history | ✅ qoh/backorder/reorder; no per-shop `sellable`, `avg_cost` |
| ls_serialized | serial_history | ✅ |
| ls_transfers, ls_transfer_items | inventory_transfer_history, transfer_item_history | ✅ |
| ls_special_orders | special_order_history | ✅ |
| ls_inventory_count_calcs / items / reconciles | inventory_count_calculation, inventory_count_item_history, inventory_count_reconcile | ✅ |
| ls_vendors | vendor_history | ✅ (`rate` missing) |
| ls_purchase_orders | order_history | ✅ (`employee_id`, `created_by_employee_id`, `has_shipments`, vendor currency missing) |
| ls_purchase_order_lines | order_line_history | ✅ |
| ls_item_vendor_nums | item_vendor_num_history | ✅ (`cost` missing) |
| ls_shops, ls_registers, ls_employees | shop_history, register_history, employee_history | ✅ (`tip_enabled` on register missing) |
| ls_tax_categories, ls_tax_classes | tax_category_history, tax_class_history | ✅ |
| ls_employee_hours | employee_hours | ✅ |
| ls_workorders / lines / items / statuses | work_order_history, work_order_line_history, work_order_item_history, work_order_status | ✅ |
| ls_register_counts / amounts / withdraws / calculated | register_count, register_count_amount, register_withdraw, register_calculated | ✅ |

### Gaps — no Fivetran source
| Cube table | Impact |
|---|---|
| **tips**: `ls_sales.calc_tips`, `tip_enabled`, `tip_employee_id`; `ls_sale_payments.tip_amount` | Tip reporting lost |
| **ls_inventory_logs** | Stock-movement history, `last_stock_in_at`, negative-stock events lost; partially reconstructable from `item_shop_history` snapshots |
| **ls_order_shipments, ls_order_shipment_items** | PO receiving detail lost (only `num_received`/`checked_in` on order_line_history remain) |
| **ls_vendor_returns** | Returns-to-vendor lost |
| **ls_processing_fees** | Card processing fee analytics lost |
| ls_sale_accounts, ls_item_components, ls_item_fees, ls_seasons (only `season_id`), ls_tag_groups, ls_catalog_vendor_items, ls_tax_category_classes | Minor dimensions/links |
| ls_custom_fields / choices / customer_custom_field_values, ls_customer_notes | Fivetran carries a `custom` column and inline `note` on customer_history — partial |
| ls_contact_websites | `website_url` inline on customer/contact history — partial |

Fivetran adds pre-aggregated helper tables Albert could use: `payment_by_day`, `tax_by_day`, `discount_by_day`, `tax_class_sales_by_day`, `order_by_tax_class`.

---

## Bottom line

| Source | Semantic layer coverage | Real gaps | Recommendation |
|---|---|---|---|
| Xero accounting/reference | ✅ complete (2 minor cols, budgets, files) | payment terms, budgets, files | Re-point `xo_*` at Fivetran; keep pnl/gst derivation; chase the Journals scope for future GL work |
| Xero AU payroll | ❌ ~30% | pay runs, payslips, super, pay items, calendars | Keep Albert's own payroll extraction for these endpoints, or retire the payroll cubes |
| Deputy | ✅ complete bar one dimension | leave-rule names | Re-point `dp_*`; hardcode/derive leave-rule labels or drop `paid_leave` |
| Lightspeed R-Series | ◐ ~80% of tables, ~90% of the analytics people actually ask for | tips, inventory logs, shipments, vendor returns, processing fees | Re-point `ls_*`; decide whether the five gaps justify keeping Albert's own extraction for those endpoints only |
