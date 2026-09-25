import type { DimensionDeclaration, FactDeclaration } from "./types.js";

export const dimensionDeclarations = Object.freeze([
  { id: "calendar_day", table: "core.calendar_day", grain: "one Gregorian calendar date", tenantScoped: false },
  { id: "location", table: "core.location", grain: "one tenant-local trading location", tenantScoped: true },
  { id: "register", table: "core.register", grain: "one register at one location", tenantScoped: true },
  { id: "channel", table: "core.channel", grain: "one tenant-local canonical sales channel", tenantScoped: true },
  { id: "legal_entity", table: "core.legal_entity", grain: "one legal entity", tenantScoped: true },
  { id: "person", table: "core.person", grain: "one natural person", tenantScoped: true },
  { id: "customer_account", table: "core.customer_account", grain: "one customer account", tenantScoped: true },
  { id: "worker", table: "core.worker", grain: "one worker identity", tenantScoped: true },
  { id: "employment_episode", table: "core.employment_episode", grain: "one continuous employment episode", tenantScoped: true, effectiveDated: true },
  { id: "supplier", table: "core.supplier", grain: "one supplier", tenantScoped: true },
  { id: "product", table: "core.product", grain: "one product family", tenantScoped: true },
  { id: "product_variant", table: "core.product_variant", grain: "one sellable product variant", tenantScoped: true },
  { id: "product_category", table: "core.product_category", grain: "one category node", tenantScoped: true, effectiveDated: true },
  { id: "gl_account", table: "core.gl_account", grain: "one general-ledger account", tenantScoped: true },
  { id: "tax_code", table: "core.tax_code", grain: "one tax treatment", tenantScoped: true },
  { id: "stock_location", table: "core.stock_location", grain: "one stock-holding location", tenantScoped: true },
] satisfies readonly DimensionDeclaration[]);

export const factDeclarations = Object.freeze([
  {
    id: "commerce_order",
    table: "core.commerce_order",
    grain: "one canonical commercial order",
    primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "location", foreignKey: "location_id", cardinality: "many_to_one", nullable: false },
      { dimension: "register", foreignKey: "register_id", cardinality: "many_to_one", nullable: true },
      { dimension: "channel", foreignKey: "channel_id", cardinality: "many_to_one", nullable: false },
      { dimension: "customer_account", foreignKey: "customer_account_id", cardinality: "many_to_one", nullable: true },
      { dimension: "worker", foreignKey: "worker_id", cardinality: "many_to_one", nullable: true },
    ],
    additiveFields: {
      gross_amount: "additive",
      discount_amount: "additive",
      net_amount_inc_tax: "additive",
      tax_amount: "additive",
      net_amount_ex_tax: "additive",
      total_cost: "additive",
    },
    timeRoles: ["ordered_at", "completed_at", "fulfilled_at", "business_date"],
    defaultTimeRole: "completed_at",
    refundBehaviour: "separate_reversal_fact",
    voidBehaviour: "retain_with_status",
    reversalBehaviour: "event_link",
  },
  {
    id: "commerce_order_line",
    table: "core.commerce_order_line",
    grain: "one sellable line on one canonical order",
    primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "product_variant", foreignKey: "product_variant_id", cardinality: "many_to_one", nullable: true },
      { dimension: "location", foreignKey: "location_id", cardinality: "many_to_one", nullable: false },
      { dimension: "register", foreignKey: "register_id", cardinality: "many_to_one", nullable: true },
      { dimension: "channel", foreignKey: "channel_id", cardinality: "many_to_one", nullable: false },
      { dimension: "customer_account", foreignKey: "customer_account_id", cardinality: "many_to_one", nullable: true },
      { dimension: "worker", foreignKey: "worker_id", cardinality: "many_to_one", nullable: true },
      { dimension: "tax_code", foreignKey: "tax_code_id", cardinality: "many_to_one", nullable: true },
    ],
    additiveFields: {
      quantity: "additive", gross_amount: "additive", discount_amount: "additive",
      net_amount_inc_tax: "additive", tax_amount: "additive", net_amount_ex_tax: "additive",
      total_cost: "additive", unit_price: "non_additive", unit_cost: "non_additive",
    },
    timeRoles: ["ordered_at", "completed_at", "fulfilled_at", "business_date"],
    defaultTimeRole: "completed_at",
    refundBehaviour: "separate_reversal_fact",
    voidBehaviour: "exclude",
    reversalBehaviour: "event_link",
  },
  {
    id: "commerce_payment", table: "core.commerce_payment", grain: "one tender or payment event", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "location", foreignKey: "location_id", cardinality: "many_to_one", nullable: false },
      { dimension: "channel", foreignKey: "channel_id", cardinality: "many_to_one", nullable: true },
    ],
    additiveFields: { amount: "additive" }, timeRoles: ["paid_at", "business_date"], defaultTimeRole: "paid_at",
    refundBehaviour: "subtract", voidBehaviour: "exclude", reversalBehaviour: "event_link",
  },
  {
    id: "commerce_refund", table: "core.commerce_refund", grain: "one money-level payment refund", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "location", foreignKey: "location_id", cardinality: "many_to_one", nullable: false },
      { dimension: "worker", foreignKey: "worker_id", cardinality: "many_to_one", nullable: true },
    ],
    additiveFields: {
      refund_amount_inc_tax: "additive", tax_amount: "additive", refund_amount_ex_tax: "additive",
    },
    timeRoles: ["refunded_at", "business_date"], defaultTimeRole: "refunded_at",
    refundBehaviour: "subtract", voidBehaviour: "exclude", reversalBehaviour: "event_link",
  },
  {
    id: "commerce_refund_line", table: "core.commerce_refund_line", grain: "one refund allocation linked to one original order line", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "location", foreignKey: "location_id", cardinality: "many_to_one", nullable: false },
      { dimension: "product_variant", foreignKey: "product_variant_id", cardinality: "many_to_one", nullable: true },
      { dimension: "worker", foreignKey: "worker_id", cardinality: "many_to_one", nullable: true },
    ],
    additiveFields: { quantity: "additive", refund_amount_inc_tax: "additive", tax_amount: "additive", refund_amount_ex_tax: "additive", total_cost_reversed: "additive" },
    timeRoles: ["refunded_at", "business_date"], defaultTimeRole: "refunded_at",
    refundBehaviour: "subtract", voidBehaviour: "not_applicable", reversalBehaviour: "event_link",
  },
  {
    id: "commerce_payment_fee", table: "core.commerce_payment_fee", grain: "one processing-fee assessment or adjustment", primaryKey: ["tenant_id", "id"],
    relationships: [],
    additiveFields: { amount: "additive" },
    timeRoles: ["effective_at", "business_date"], defaultTimeRole: "effective_at",
    refundBehaviour: "not_applicable", voidBehaviour: "not_applicable", reversalBehaviour: "signed_amount",
  },
  {
    id: "inventory_movement", table: "core.inventory_movement", grain: "one stock quantity-changing event", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "product_variant", foreignKey: "product_variant_id", cardinality: "many_to_one", nullable: false },
      { dimension: "stock_location", foreignKey: "stock_location_id", cardinality: "many_to_one", nullable: false },
    ],
    additiveFields: { quantity_delta: "additive", total_cost: "additive", unit_cost: "non_additive" },
    timeRoles: ["occurred_at", "business_date"], defaultTimeRole: "occurred_at",
    refundBehaviour: "not_applicable", voidBehaviour: "not_applicable", reversalBehaviour: "signed_amount",
  },
  {
    id: "inventory_balance_snapshot", table: "core.inventory_balance_snapshot", grain: "one variant by stock location by snapshot date", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "product_variant", foreignKey: "product_variant_id", cardinality: "many_to_one", nullable: false },
      { dimension: "stock_location", foreignKey: "stock_location_id", cardinality: "many_to_one", nullable: false },
    ],
    additiveFields: { quantity_on_hand: "last_value_over_time", stock_value: "last_value_over_time", unit_cost: "non_additive" },
    timeRoles: ["snapshot_at", "snapshot_date"], defaultTimeRole: "snapshot_date",
    refundBehaviour: "not_applicable", voidBehaviour: "not_applicable", reversalBehaviour: "not_applicable",
  },
  {
    id: "purchase_order_line", table: "core.purchase_order_line", grain: "one supplier purchase-order line", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "supplier", foreignKey: "supplier_id", cardinality: "many_to_one", nullable: true },
      { dimension: "product_variant", foreignKey: "product_variant_id", cardinality: "many_to_one", nullable: true },
      { dimension: "stock_location", foreignKey: "stock_location_id", cardinality: "many_to_one", nullable: true },
    ],
    additiveFields: { ordered_quantity: "additive", received_quantity: "additive", unit_cost: "non_additive", total_cost: "additive" },
    timeRoles: ["ordered_at", "expected_at", "received_at", "business_date"], defaultTimeRole: "ordered_at",
    refundBehaviour: "not_applicable", voidBehaviour: "retain_with_status", reversalBehaviour: "event_link",
  },
  {
    id: "finance_journal_line", table: "core.finance_journal_line", grain: "one debit or credit journal line", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "legal_entity", foreignKey: "legal_entity_id", cardinality: "many_to_one", nullable: false },
      { dimension: "gl_account", foreignKey: "gl_account_id", cardinality: "many_to_one", nullable: false },
      { dimension: "tax_code", foreignKey: "tax_code_id", cardinality: "many_to_one", nullable: true },
      { dimension: "location", foreignKey: "location_id", cardinality: "many_to_one", nullable: true },
    ],
    additiveFields: { debit_amount: "additive", credit_amount: "additive", tax_amount: "additive" },
    timeRoles: ["posted_at", "business_date"], defaultTimeRole: "posted_at",
    refundBehaviour: "not_applicable", voidBehaviour: "exclude", reversalBehaviour: "event_link",
  },
  {
    id: "finance_invoice_line", table: "core.finance_invoice_line", grain: "one sales-invoice or bill line", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "legal_entity", foreignKey: "legal_entity_id", cardinality: "many_to_one", nullable: false },
      { dimension: "customer_account", foreignKey: "customer_account_id", cardinality: "many_to_one", nullable: true },
      { dimension: "supplier", foreignKey: "supplier_id", cardinality: "many_to_one", nullable: true },
      { dimension: "gl_account", foreignKey: "gl_account_id", cardinality: "many_to_one", nullable: true },
      { dimension: "tax_code", foreignKey: "tax_code_id", cardinality: "many_to_one", nullable: true },
      { dimension: "location", foreignKey: "location_id", cardinality: "many_to_one", nullable: true },
    ],
    additiveFields: { quantity: "additive", unit_amount: "non_additive", net_amount_ex_tax: "additive", tax_amount: "additive", net_amount_inc_tax: "additive", outstanding_amount: "additive" },
    timeRoles: ["issued_at", "due_at", "paid_at", "business_date"], defaultTimeRole: "issued_at",
    refundBehaviour: "subtract", voidBehaviour: "exclude", reversalBehaviour: "event_link",
  },
  {
    id: "finance_bank_transaction", table: "core.finance_bank_transaction", grain: "one bank-feed transaction", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "legal_entity", foreignKey: "legal_entity_id", cardinality: "many_to_one", nullable: false },
      { dimension: "gl_account", foreignKey: "gl_account_id", cardinality: "many_to_one", nullable: true },
      { dimension: "location", foreignKey: "location_id", cardinality: "many_to_one", nullable: true },
    ],
    additiveFields: { amount: "additive", tax_amount: "additive" },
    timeRoles: ["transaction_at", "posted_at", "business_date"], defaultTimeRole: "transaction_at",
    refundBehaviour: "not_applicable", voidBehaviour: "exclude", reversalBehaviour: "signed_amount",
  },
  {
    id: "finance_settlement", table: "core.finance_settlement", grain: "one provider payout or settlement", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "location", foreignKey: "location_id", cardinality: "many_to_one", nullable: true },
    ],
    additiveFields: { gross_amount: "additive", fee_amount: "additive", net_amount: "additive" },
    timeRoles: ["initiated_at", "settled_at", "business_date"], defaultTimeRole: "settled_at",
    refundBehaviour: "not_applicable", voidBehaviour: "not_applicable", reversalBehaviour: "signed_amount",
  },
  {
    id: "finance_settlement_line", table: "core.finance_settlement_line", grain: "one itemized component of one provider settlement", primaryKey: ["tenant_id", "id"],
    relationships: [],
    additiveFields: { amount: "additive", fee_amount: "additive" },
    timeRoles: ["effective_at", "business_date"], defaultTimeRole: "effective_at",
    refundBehaviour: "subtract", voidBehaviour: "not_applicable", reversalBehaviour: "signed_amount",
  },
  {
    id: "workforce_shift", table: "core.workforce_shift", grain: "one planned work interval", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "worker", foreignKey: "worker_id", cardinality: "many_to_one", nullable: false },
      { dimension: "employment_episode", foreignKey: "employment_episode_id", cardinality: "many_to_one", nullable: true },
      { dimension: "location", foreignKey: "location_id", cardinality: "many_to_one", nullable: false },
    ],
    additiveFields: { rostered_minutes: "duration_additive", estimated_cost: "additive" },
    timeRoles: ["starts_at", "ends_at", "business_date"], defaultTimeRole: "starts_at",
    refundBehaviour: "not_applicable", voidBehaviour: "exclude", reversalBehaviour: "not_applicable",
  },
  {
    id: "workforce_time_entry", table: "core.workforce_time_entry", grain: "one actual worked interval", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "worker", foreignKey: "worker_id", cardinality: "many_to_one", nullable: false },
      { dimension: "employment_episode", foreignKey: "employment_episode_id", cardinality: "many_to_one", nullable: true },
      { dimension: "location", foreignKey: "location_id", cardinality: "many_to_one", nullable: false },
    ],
    additiveFields: { worked_minutes: "duration_additive", overtime_minutes: "duration_additive", labour_cost: "additive" },
    timeRoles: ["starts_at", "ends_at", "approved_at", "business_date"], defaultTimeRole: "starts_at",
    refundBehaviour: "not_applicable", voidBehaviour: "exclude", reversalBehaviour: "not_applicable",
  },
  {
    id: "workforce_leave", table: "core.workforce_leave", grain: "one leave interval", primaryKey: ["tenant_id", "id"],
    relationships: [
      { dimension: "worker", foreignKey: "worker_id", cardinality: "many_to_one", nullable: false },
      { dimension: "employment_episode", foreignKey: "employment_episode_id", cardinality: "many_to_one", nullable: true },
      { dimension: "location", foreignKey: "location_id", cardinality: "many_to_one", nullable: true },
    ],
    additiveFields: { leave_minutes: "duration_additive", leave_cost: "additive" },
    timeRoles: ["starts_at", "ends_at", "business_date"], defaultTimeRole: "starts_at",
    refundBehaviour: "not_applicable", voidBehaviour: "exclude", reversalBehaviour: "not_applicable",
  },
] satisfies readonly FactDeclaration[]);

export const factsById = Object.freeze(
  Object.fromEntries(factDeclarations.map((fact) => [fact.id, fact])) as Record<
    (typeof factDeclarations)[number]["id"],
    (typeof factDeclarations)[number]
  >,
);

export const dimensionsById = Object.freeze(
  Object.fromEntries(dimensionDeclarations.map((dimension) => [dimension.id, dimension])) as Record<
    (typeof dimensionDeclarations)[number]["id"],
    (typeof dimensionDeclarations)[number]
  >,
);
