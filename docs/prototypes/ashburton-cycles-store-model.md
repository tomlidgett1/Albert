# Ashburton Cycles store model

> Prototype generated from a read-only inspection on 9 August 2026 (Australia/Melbourne). This file is deliberately not connected to Albert's runtime, semantic registry, tenant overlay, prompts, onboarding, sync jobs, or databases. It is an example of the durable store-specific model a discovery process could produce.

## Document contract

```yaml
document_type: tenant_store_model_prototype
tenant: Ashburton Cycles
status: unpublished_example_only
runtime_enabled: false
generated_at: 2026-08-09
evidence_cutoff: 2026-08-09
contains_credentials: false
contains_customer_contact_data: false
contains_employee_names: false
```

This document separates four things that should never be collapsed into one prompt:

1. confirmed business preferences;
2. source-reported business facts;
3. Albert's evidence-backed inferences;
4. query and quality rules discovered from this tenant's data.

Confidence means:

- **Confirmed** — explicitly chosen by the owner or directly reported by the authoritative source.
- **High** — directly observed and internally consistent, but not explicitly confirmed by the owner.
- **Medium** — useful inference supported by data, with a plausible alternative interpretation.
- **Low / proposed** — candidate mapping that must not silently affect a governed answer.

## Executive store picture

Ashburton Cycles appears to be a single-location Australian bicycle retailer with a substantial parts, accessories, bike and workshop catalogue. Its current store-specific defaults and source-reported settings are:

| Fact | Value | State | Evidence |
| --- | --- | --- | --- |
| Industry | Independent bicycle retail and servicing | High | Xero line of business is `Cycling shop`; Lightspeed catalogue and workshop vocabulary |
| Current location | Ashburton Cycles | Confirmed/source-reported | Lightspeed shop and current canonical location |
| Primary register | Counter | High | Active Lightspeed register for the Ashburton shop |
| Observed channel | In-store | High | Current canonical dossier; no other governed channel presently observed |
| Base currency | AUD | Confirmed/source-reported | Xero Organisation |
| Country | Australia | Confirmed/source-reported | Xero Organisation |
| GST registration | Registered | Confirmed/source-reported | Xero `pays_tax = true`; active 10% input and output tax rates |
| Accounting basis | Cash | Confirmed/source-reported | Xero `sales_tax_basis = CASH` |
| GST reporting | Quarterly | Confirmed/source-reported | Xero `sales_tax_period = QUARTERLY1` |
| Financial year end | 30 June | Confirmed/source-reported | Xero Organisation |
| Default meaning of “sales” | Gross takings including GST | Confirmed | Owner-approved overlay (`sales-lens = inc-gst`) |
| Tax display default | Inclusive | Confirmed | Owner-approved overlay |
| Trading-day cutoff | Midnight | Confirmed | Owner-approved overlay |
| Tenant timezone | Australia/Melbourne | Confirmed/configured | Published tenant overlay |

### Important timezone resolution

The tenant overlay says `Australia/Melbourne`, while the Lightspeed shop reports `Australia/Sydney` and Xero reports its Windows-style Australian Eastern timezone. Melbourne and Sydney currently share clock rules, but the source values are not semantically identical.

**Resolution for this prototype:** the explicit tenant overlay wins. Use `Australia/Melbourne` for business dates and disclose the Lightspeed mismatch as a configuration observation. Do not rewrite the source value.

### Inferred trading hours

The latest published dossier infers the following from the 5th–95th percentile of completed-sale times over 90 days:

| Day | Observed trading window |
| --- | --- |
| Monday | 10:02 am–5:38 pm |
| Tuesday | 9:27 am–5:07 pm |
| Wednesday | 10:53 am–5:23 pm |
| Thursday | 9:14 am–5:35 pm |
| Friday | 9:49 am–5:47 pm |
| Saturday | 10:08 am–3:46 pm |
| Sunday | 10:58 am–2:51 pm |

These are **observed transaction windows**, not confirmed opening hours. Confidence is medium (`0.75`). They should be useful for interpreting “during trading hours,” but not presented as the shop's advertised hours without confirmation.

An older dossier inferred February as the strongest month and August as the quietest. That conclusion is retained only as a low-confidence historical observation because the latest dossier no longer contains seasonality and the current canonical history is incomplete.

## Connection and usability snapshot

Connection status and analytical usability are different concepts. The source can remain authorised while a domain is unsafe for governed answers.

| System | What exists | Current usability in this prototype |
| --- | --- | --- |
| Lightspeed Retail R-Series | Connected; active connector pack `2.0.0`; substantial staged POS history | Best available operational source, but current readiness metadata conflicts with connection metadata and core quality gates are failing. Treat semantic answers as blocked or qualified until runtime health resolves. |
| Xero | Connected; organisation, chart of accounts, invoices, bank transactions and payments staged | Authentication health is currently `error` and the connection is authority-ineligible. Canonical finance facts are empty. Keep source-reported organisation facts as last-known facts, but do not produce governed finance or reconciliation answers from them. |
| Deputy | Connected; healthy OAuth; polling/reconciliation mode because webhook installation is outstanding | No Deputy rows are staged. Workforce structure, rosters, timesheets, labour cost and cross-system staff identity remain unavailable. |

### Health contradiction that must travel with this model

The Lightspeed connection record is `connected / healthy`, but its domain-readiness records are `blocked` with `connection_disconnected` and “Connection data is scheduled for deletion.” This is a control-plane contradiction, not a business fact.

**Instruction:** health and deletion state must be checked live at question time. This document must never override a current deletion fence, readiness block, or connection-generation fence.

## Confirmed tenant defaults

This is the small, durable overlay Albert could safely load for relevant questions:

```yaml
tenant_defaults:
  timezone: Australia/Melbourne
  trading_day_cutoff: "00:00"
  tax_display: inclusive
  sales_default_metric: commerce.gross_takings_inc_gst
  fiscal_year:
    end_month: 6
    end_day: 30
  accounting_basis: cash
  base_currency: AUD
  gst:
    registered: true
    standard_rate: 0.10
    reporting_frequency: quarterly
```

Only the timezone, cutoff, tax-display and sales-lens choices are owner-confirmed overlay values. The fiscal, accounting, currency and GST facts are source-reported by Xero and must retain their source freshness.

## Store vocabulary

| Store term | Proposed interpretation | Confidence | Handling |
| --- | --- | --- | --- |
| sales, takings, turnover | Gross takings including GST | Confirmed | Use the confirmed default unless the question explicitly asks for ex-GST or accounting revenue |
| Counter | The single active Lightspeed register at Ashburton Cycles | High | Resolve to the canonical register, not a text filter |
| servicing, service | Workshop/service activity; likely Lightspeed `Services` / `Workshop` catalogue families and Xero revenue account `201` | Medium | Retrieve both meanings; clarify if operational workshop work and accounting service revenue would materially differ |
| workshop | Lightspeed work orders and workshop/service product categories | Medium | Work-order staging is currently too shallow for a governed answer |
| P&A | Parts and accessories | Medium | Inferred from promotion names such as “Black Friday … P&A”; retain as a proposed synonym until confirmed |
| bikes | Lightspeed `Bikes/*` category family | High | Resolve through the category hierarchy, not product-description text |
| staff performance | Employee-attributed completed POS sales, optionally aligned to Deputy worked hours | Medium | POS attribution exists; Deputy hours do not, so productivity-per-hour is unavailable |
| top customers | A named discount/programme concept, not necessarily the governed definition of highest-value customers | Medium | Do not treat use of the “Top Customers” discount as membership without confirmation |
| ARC Riders | A customer/service-discount programme | Medium | Programme semantics are unknown; answer only observable discount usage unless confirmed |

## Source-specific data map

### Lightspeed: operational commerce authority

All current Lightspeed reads must pin `mapping_version = '2.0.0'` and `tombstone = false`. The retired `m2-v1` generation still coexists in staging for several tables; querying both generations can duplicate shops, registers, categories, manufacturers, payment types and transaction records.

| Business concept | Source surface | Store-specific rule |
| --- | --- | --- |
| Sale/order header | `source_lightspeed.ls_sales` | Include completed, non-voided sales for governed sales. Use `complete_time` for the default sales time role. |
| Sellable/refund line | `source_lightspeed.ls_sale_lines` | Join to the parent sale for completion, void and completion-time state. The active line snapshot's copied status/time columns are currently unpopulated. Negative quantity is a refund signal, but governed refund contracts still decide treatment. |
| Tender/payment | `source_lightspeed.ls_sale_payments` + `ls_payment_types` | Exclude archived/reversed tender records according to the governed payment contract; do not equate tender with order value. |
| Products | `source_lightspeed.ls_items` | Current active pack contains 17,005 active SKUs. Category, manufacturer and cost fields have complete non-null coverage in the staged snapshot. |
| Categories | `source_lightspeed.ls_categories` | 79 category nodes. Use `full_path_name`; do not flatten child names without their parent. |
| Brands/manufacturers | `source_lightspeed.ls_manufacturers` | 415 manufacturers. `Generic` is a real high-volume value and must not be converted to null. |
| Inventory by store | `source_lightspeed.ls_item_shops` | `shop_id = 0` mirrors the live `shop_id = 1` quantities across all 17,005 items. Never sum both. The live Ashburton shop is `shop_id = 1`. |
| Customers | `source_lightspeed.ls_customers` | 9,385 active source customer accounts. On sales, `customer_id = 0` means no identified customer; 23,125 of 61,197 staged sale headers have a non-zero customer ID. |
| Employees | `source_lightspeed.ls_employees` | Nine currently active source employees; historical sales contain more employee IDs. Resolve through the effective-dated canonical worker graph. Never join on employee name. |
| Suppliers | `source_lightspeed.ls_vendors` | 572 active source suppliers. |
| Purchase orders | `source_lightspeed.ls_purchase_orders` and `ls_purchase_order_lines` | 4,198 headers from May 2018 to August 2026; use canonical purchase-order lines when the transform is complete. |
| Workshop | `source_lightspeed.ls_workorders`, child work-order tables and `ls_workorder_statuses` | Only three work-order headers are present in the new staging surface, so it is not representative of the business's workshop history. |
| Discounts/programmes | `source_lightspeed.ls_discounts` and `ls_sale_lines.discount_id` | `discount_id = 0` means no named discount. Exactly 4,571 staged lines have a non-zero ID and a non-zero discount amount or rate. |
| Tax | `source_lightspeed.ls_tax_categories`, `ls_tax_classes` and line tax components | Store tax categories are tax-inclusive at 10%. Preserve the explicit line components; do not reverse-engineer tax from totals. |

#### Lightspeed catalogue shape

The largest active SKU families are:

| Category | Active SKUs |
| --- | ---: |
| Parts/Wheels & Tyres | 2,613 |
| Bikes/City | 2,405 |
| Parts/Drivetrain | 2,001 |
| Gift & Miscellaneous/Other | 1,267 |
| Parts/Cockpit | 1,143 |
| Clothing & Protection/Helmets | 846 |
| Parts/Brakes | 572 |
| Clothing & Protection/Gloves | 448 |
| Parts/Saddles & Seatposts | 404 |
| Bikes/Kids | 399 |

The taxonomy also contains store-specific naming that should be preserved but normalised for search, including `Accessories1`, `Workshop`, `Services`, and legacy-looking roots such as `Test`.

The largest manufacturer values are `Generic`, `Shimano`, `Giant`, `Apollo`, `BBB`, `Met`, `Norco`, `VITTORIA`, `Electra`, `ZEFAL`, `Fox`, and `SRAM`. Manufacturer spelling and case should be treated as source vocabulary; synonyms may improve retrieval but must not rewrite source lineage.

#### Lightspeed payment vocabulary

Active payment types are:

```text
Adjustment, Cash, Check, Credit Account, Credit Card, Debit Card,
eCom, Gift Card, PROMO GIFT CARD
```

`Debit Card` is represented by Lightspeed's generic `credit card` type. `PROMO GIFT CARD` and `Check` are user-defined types. These labels should remain visible in source-specific exploration, while governed tender metrics group them through an explicit mapping.

#### Lightspeed workshop vocabulary

Observed work-order statuses include:

```text
Open, Estimate, Quote, TO ORDER, Waiting, TODAY, Staff, VAN, Nest,
Non-Bike, Finished, Finished + Text Sent, Done & Paid
```

Several are workflow queues rather than economic states. A future workshop semantic pack should map them explicitly; it should not infer completion solely from sort order or label text.

### Xero: statutory finance authority when healthy

Xero reports Ashburton Cycles as an active Australian company using AUD, cash-basis tax reporting, a 30 June year end and quarterly GST. The staged chart has 114 active accounts, including ten bank-type accounts.

The following are **proposed account semantics**, not installed mappings:

| Candidate concept | Xero account evidence | Confidence |
| --- | --- | --- |
| Retail sales | `200 — Sales` (`REVENUE`, GST on income) | High |
| Servicing revenue | `201 — Servicing Revenue` (`REVENUE`, GST on income) | High |
| Other revenue | `260 — Other Revenue` | High |
| Stock/inventory assets | `321 — Inventory excl. Bikes`, `322 — Inventory Bikes`, and system inventory account `630 — Inventory` | Medium; relationships need accounting review |
| Discounts on sales | `123 — Discounts on Sales` (`DIRECTCOSTS`) | High as chart meaning; treatment in margin needs review |
| Wages expense | `477 — Wages and Salaries` | High |
| Wages payable | `804 — Wages Payable - Payroll` | High |
| GST control | `820 — GST` (Xero system GST account) | High |
| Accounts receivable | `610 — Accounts Receivable` (system `DEBTORS`) | Confirmed/source-reported |
| Accounts payable | `800 — Accounts Payable` (system `CREDITORS`) | Confirmed/source-reported |

Available staged finance surfaces include:

- 4,816 invoices and 24,951 invoice lines;
- 15,134 bank transactions and 15,476 bank-transaction lines;
- 4,715 payments;
- 456 contacts;
- no staged journals or journal lines;
- no staged tracking categories.

The source data is useful for discovery, but the current canonical finance tables contain no rows and Xero is not authority-eligible while its authentication health is in error. Therefore:

```yaml
xero_answer_policy:
  organisation_settings: last_known_source_fact_with_freshness
  governed_finance_metrics: unavailable
  pos_to_ledger_reconciliation: unavailable
  pos_to_bank_reconciliation: unavailable
  account_mapping_candidates: review_only
```

Do not select an “operating bank account” from the ten active bank accounts by name alone. That requires explicit owner/accountant confirmation or deterministic settlement evidence.

### Deputy: workforce authority once data exists

Deputy is authorised and configured for scheduled polling plus reconciliation, but all six expected source tables are currently empty:

```text
companies, operational_units, employees, rosters, timesheets, leave
```

Consequences:

- no source-reported Deputy locations or operational units;
- no Deputy-to-Lightspeed worker identity candidates;
- no rostered or worked hours;
- no labour-cost coverage;
- no defensible “sales per worked hour” or “best employee per hour” answer.

A quality check reporting 100% labour-cost or shift/timesheet coverage with zero eligible rows must not be treated as evidence of real coverage.

## Canonical and semantic availability

The canonical layer is much shallower than staging:

| Canonical surface | Current rows |
| --- | ---: |
| Locations | 1 |
| Registers | 1 |
| Workers | 6 |
| Product variants | 133 |
| Product categories | 79 |
| Customer accounts | 70 |
| Suppliers | 3 |
| Commerce orders | 378 |
| Commerce order lines | 808 |
| Commerce payments | 349 |
| Sales day/location mart | 32 |
| Inventory snapshots | 0 |
| Purchase-order lines | 0 |
| Finance facts | 0 |
| Workforce facts | 0 |

Current source-authority rules correctly assign Lightspeed to operational sales, product master, customer master and stock. Finance and workforce authority have not been made usable in the canonical layer.

**Instruction:** large staged row counts do not make a governed metric available. The semantic service must continue to capability-gate against canonical coverage, quality and freshness.

## Store-specific query guardrails

These are the kinds of instructions the discovery process should produce as structured rules, not freeform prompt prose:

```yaml
query_guardrails:
  lightspeed:
    required_mapping_version: 2.0.0
    required_filters:
      tombstone: false
    sentinels:
      customer_id: { value: 0, meaning: unidentified_customer }
      discount_id: { value: 0, meaning: no_named_discount }
      inventory_shop_id: { value: 0, meaning: duplicate_account_rollup, action: exclude }
    sales:
      completed_state_source: ls_sales.completed
      void_state_source: ls_sales.voided
      default_time_source: ls_sales.complete_time
      line_parent_join: [tenant_id, sale_id]
    inventory:
      current_store_shop_id: 1
      cost_source: ls_items.avg_cost_or_default_cost
      item_shop_cost_warning: ls_item_shops.avg_cost_is_unpopulated
  xero:
    authority_eligible: false
    answer_policy: last_known_settings_only
  deputy:
    staged_rows: 0
    answer_policy: unavailable
```

These rules are evidence for compilers and validators. They must not create a direct agent-to-SQL path.

## Current quality gates

The latest quality evidence prevents this prototype from claiming that all staged history is governed:

| Gate | Result | Meaning for answers |
| --- | --- | --- |
| `line_maths` | Failed: 6 completed headers outside tolerance | Do not mark affected sales totals Verified |
| `tender_reconciles` | Failed: 5 cases | Do not equate order value and captured tender |
| `canonical_mapping_total` | Warning: 83,634 open mapping-quarantine records | Canonical coverage is incomplete |
| `schema_drift` | Warning: 9,196 unresolved observations | Source shape requires review |
| Connector quarantine | Warning: 30,202 unresolved records in the connector rollup | Stream-level availability must remain qualified |
| POS-to-ledger tolerance | Warning; large aligned variance | Xero posting/linkage is not established |
| Posting bridge coverage | 0 linked of 32 reconciliation rows | POS-to-ledger questions unavailable |
| Settlement bridge coverage | 0 linked of 333 eligible tenders | POS-to-bank questions unavailable |
| Observation coverage | Passed for the small canonical commerce set | Lineage exists for what has been canonicalised; it does not prove full-history coverage |
| Cost coverage | Passed for 786 eligible canonical lines | Useful within that covered set only |

Zero-row “passed” checks are not positive evidence. This applies especially to finance, inventory continuity and workforce checks while their canonical facts are empty.

## Open confirmations

The discovery process should ask only questions whose answers materially change analysis:

1. Does “servicing” mean both Lightspeed workshop activity and Xero account `201`, or should those remain distinct lenses?
2. Does Lightspeed post sales into Xero as daily summaries, individual transactions, or another pattern?
3. Which Xero bank account receives ordinary POS settlements?
4. Is Lightspeed `shop_id = 0` an account-level rollup that should always be excluded when shop `1` is present? The quantities currently mirror exactly, so summing both doubles stock.
5. Should `P&A` be remembered as “parts and accessories”?
6. Are the inferred trading windows close enough to actual opening hours to use as the store default?
7. What should “best employee” mean by default: gross profit, net sales, or gross profit per worked hour?
8. Once Deputy data arrives, which operational unit corresponds to the Lightspeed Ashburton shop and which staff identities match?

## Example of question-time retrieval

The whole document should not be injected into every turn. For “How are sales going this month?” Albert might retrieve only this projection:

```yaml
tenant_context_slice:
  business: Ashburton Cycles
  timezone: Australia/Melbourne
  trading_day_cutoff: "00:00"
  default_sales_lens: commerce.gross_takings_inc_gst
  tax_display: inclusive
  operational_sales_authority: lightspeed-r
  location_default: Ashburton Cycles
  health:
    readiness: blocked
    line_maths: failed
    canonical_backfill: incomplete
  response_policy:
    verified_allowed: false
    disclose: Current sales coverage and reconciliation checks are incomplete.
```

For “What does my Xero setup say about GST?” the retrieved slice would instead contain the source-reported cash basis, quarterly reporting period, 10% input/output rates, 30 June year end, Xero freshness, and current auth-health warning.

## What this prototype reveals about the product design

1. **Store memory must outlive temporary connector health.** The latest dossier omits Xero-derived currency, GST and accounting-basis facts even though an earlier source-reported dossier contained them; later dossier publications occurred while Xero was unhealthy. A better store model keeps the last-known fact and separately marks current source availability and freshness.
2. **The dossier needs material-change suppression.** This tenant accumulated 209 dossier versions between 4 and 7 August. Versioning is correct, but publication should occur only when the evidence bundle or a meaningful fact changes.
3. **Data-location notes are compiler rules, not prompt instructions.** The sentinel values, mapping-version pin and parent-sale status rule should be enforced deterministically.
4. **Availability must be evidence-aware.** “Connected,” “rows exist,” “capability declared,” and “governed answer ready” are four different states.
5. **Most tenant knowledge is small.** The truly reusable store overlay is only a few defaults, synonyms, mappings and exceptions. The detailed table census belongs in a retrievable evidence catalogue.

## Non-activation statement

This file is documentation only. Nothing in it has been published to `control_plane.dossiers`, `control_plane.tenant_overlays`, the semantic registry, an agent prompt, a connector pack, or a runtime configuration. No sync, transform, onboarding, identity, authority, or deletion state was changed while producing it.
