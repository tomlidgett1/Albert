#!/usr/bin/env node
/**
 * Coverage audit for the Albert V3 semantic layer (binding gate).
 *
 * Cross-checks every column of every sales/customers playbook table in
 * connectors/lightspeed-r/tables.json against the compiled Cube /v1/meta.
 * Every column must either map to a model member or sit on the explicit
 * exclusion list with a reason. Unexplained gaps fail the audit (exit 1).
 *
 * Run with the Cube dev server up: node scripts/coverage-audit.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CUBE_URL = process.env.CUBE_URL || 'http://localhost:4000';
const CATALOGUE = path.join(here, '..', '..', 'connectors', 'lightspeed-r', 'tables.json');
const SHOPIFY_REGISTRY = path.join(
  here,
  '..',
  '..',
  'connectors',
  'shopify',
  'generated',
  'admin-graphql-2026-07.json',
);

/** Exact normalized Shopify stream -> private Cube projection. */
const SHOPIFY_TABLE_TO_CUBE = Object.freeze({
  shopify_shop: 'shopify_shop',
  shopify_locations: 'shopify_locations',
  shopify_products: 'shopify_products',
  shopify_product_variants: 'shopify_product_variants',
  shopify_customers: 'shopify_customers',
  shopify_orders: 'shopify_orders',
  shopify_order_lines: 'shopify_order_lines',
  shopify_transactions: 'shopify_transactions',
  shopify_refund_lines: 'shopify_refund_lines',
  shopify_inventory_levels: 'shopify_inventory_levels',
  shopify_fulfillments: 'shopify_fulfillments',
  shopify_returns: 'shopify_returns',
  shopify_discounts: 'shopify_discounts',
  shopify_fields: 'shopify_fields',
});

const SHOPIFY_EXHAUSTIVE_MEMBERS = Object.freeze([
  'schema_path', 'root_field', 'object_type', 'graphql_id', 'parent_graphql_id',
  'field_name', 'field_type', 'value_kind', 'api_version', 'required_scopes',
  'protected_data_level', 'availability', 'deprecated', 'deprecation_reason',
  'safe_value_text', 'safe_value_number', 'safe_value_boolean',
  'safe_value_timestamp', 'safe_value_json', 'observed_at', 'value_state',
  'field_observations', 'source_objects', 'populated_fields', 'sensitive_fields',
  'unavailable_fields', 'deprecated_fields', 'numeric_total', 'numeric_average',
]);

function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}
const envFile = readEnvFile(path.join(here, '..', '.env'));
const API_SECRET = process.env.CUBEJS_API_SECRET || envFile.CUBEJS_API_SECRET;

function signJwt(payload, secret) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Lineage/plumbing columns present on every staging table; never analytical. */
const UNIVERSAL_EXCLUSIONS = {
  namespaced_source_key: 'internal row key (exposed privately as row_key primary key)',
  connection_id: 'ingestion lineage',
  external_account_reference: 'ingestion lineage',
  source_record_id: 'ingestion lineage (the business id column carries the analytical value)',
  source_version: 'ingestion lineage',
  source_updated_at: 'ingestion lineage watermark',
  payload_hash: 'ingestion plumbing',
  payload_batch_id: 'ingestion plumbing',
  sync_run_id: 'ingestion plumbing',
  tombstone: 'handled in every cube base SQL (deleted rows excluded)',
  mapping_version: 'handled in every cube base SQL (latest pack selected)',
  first_ingested_at: 'ingestion timestamp, not business data',
  ingested_at: 'ingestion timestamp, not business data',
  tenant_id: 'modelled as private tenant_id dimension on every cube',
};

/** table id -> cube name for modelled tables. */
const TABLE_TO_CUBE = {
  ls_sales: 'sales',
  ls_sale_lines: 'sale_lines',
  ls_sale_payments: 'sale_payments',
  ls_sale_accounts: 'sale_accounts',
  ls_sale_voids: 'sale_voids',
  ls_cc_charges: 'cc_charges',
  ls_processing_fees: 'processing_fees',
  ls_quotes: 'quotes',
  ls_discounts: 'discounts',
  ls_payment_types: 'payment_types',
  ls_items: 'items',
  ls_categories: 'categories',
  ls_manufacturers: 'manufacturers',
  ls_seasons: 'seasons',
  ls_tags: 'tags',
  ls_tag_groups: 'tag_groups',
  ls_shops: 'shops',
  ls_registers: 'registers',
  ls_employees: 'employees',
  ls_tax_categories: 'tax_categories',
  ls_tax_classes: 'tax_classes',
  ls_tax_category_classes: 'tax_category_classes',
  ls_customers: 'customers',
  ls_contacts: 'contacts',
  ls_contact_emails: 'contact_emails',
  ls_contact_phones: 'contact_phones',
  ls_contact_websites: 'contact_websites',
  ls_customer_types: 'customer_types',
  ls_credit_accounts: 'credit_accounts',
  ls_ship_tos: 'ship_tos',
  ls_custom_fields: 'custom_fields',
  ls_custom_field_choices: 'custom_field_choices',
  ls_customer_custom_field_values: 'customer_custom_field_values',
  ls_customer_notes: 'customer_notes',
};

/** Whole tables in the sales/customers domains deliberately not modelled. */
const EXCLUDED_TABLES = {
  ls_sale_payment_signatures: 'signature image file paths; no analytical value',
  ls_sale_line_inventory_allocations: 'inventory-layer allocation detail; inventory domain is out of scope this iteration',
  ls_report_payments_by_day: 'daily report duplicate; canonical facts (sale_payments) answer these queries at finer grain',
  ls_report_sales_by_day: 'daily report duplicate; canonical facts (sales) answer these queries at finer grain',
  ls_report_sale_lines_by_day: 'daily report duplicate; canonical facts (sale_lines) answer these queries at finer grain',
};

/** catalogue column name -> model member name, where they differ. */
const RENAMES = {
  sales: {
    change: 'change_given',
    create_time: 'created_at',
    complete_time: 'completed_at',
    time_stamp: 'updated_at',
    update_time: 'vendor_updated_at',
    total: 'vendor_total',
    enable_promotions: 'promotions_enabled',
  },
  sale_lines: {
    create_time: 'created_at',
    time_stamp: 'updated_at',
    tax: 'is_taxed',
    taxed: 'is_taxed',
    require_full_reservation: 'requires_full_reservation',
    completed: 'sale_completed',
    voided: 'sale_voided',
    complete_time: 'completed_at',
  },
  sale_payments: {
    create_time: 'created_at',
    payment_id: 'external_payment_id',
    completed: 'sale_completed',
    voided: 'sale_voided',
    complete_time: 'completed_at',
  },
  sale_voids: { create_time: 'voided_at' },
  cc_charges: {
    time_stamp: 'charged_at',
    gateway_trans_id: 'gateway_transaction_id',
    exp: 'card_expiry',
    refunded: 'refunded_amount',
    amount: 'charged_amount',
  },
  processing_fees: {
    sale_payment_processing_fee_id: 'processing_fee_id',
    processing_time: 'processed_at',
    create_time: 'created_at',
    update_time: 'updated_at',
    amount: 'processed_payment_amount',
    fixed_fee: 'fixed_fees',
    variable_fee: 'variable_fees',
    variable_pct: 'variable_rate_pct',
    interchange_fees_variable_pct: 'interchange_variable_rate_pct',
    scheme_fees_variable_pct: 'scheme_variable_rate_pct',
  },
  quotes: { issue_date: 'issued_at' },
  discounts: {
    discount_amount: 'fixed_amount',
    discount_percent: 'percent',
    require_customer: 'requires_customer',
    time_stamp: 'updated_at',
  },
  payment_types: { require_customer: 'requires_customer' },
  items: {
    tax: 'is_taxed',
    avg_cost: 'average_cost',
    create_time: 'created_at',
    time_stamp: 'updated_at',
    list_on_store: 'listed_on_store',
    amount_where_use_type_default: 'default_price',
    amount_where_use_type_msrp: 'msrp',
  },
  categories: { create_time: 'created_at', time_stamp: 'updated_at' },
  manufacturers: { create_time: 'created_at', time_stamp: 'updated_at' },
  shops: {},
  registers: { open: 'is_open', open_time: 'opened_at' },
  employees: { lock_out: 'locked_out', time_stamp: 'updated_at' },
  tax_categories: { time_stamp: 'updated_at' },
  tax_classes: { time_stamp: 'updated_at' },
  customers: { dob: 'date_of_birth', create_time: 'created_at', time_stamp: 'updated_at' },
  contacts: { zip: 'postcode', time_stamp: 'updated_at' },
  contact_emails: { email_address: 'address' },
  contact_phones: { phone_number: 'number' },
  contact_websites: {},
  credit_accounts: { gift_card: 'is_gift_card', time_stamp: 'updated_at' },
  ship_tos: {
    first_name: 'recipient_first_name',
    last_name: 'recipient_last_name',
    time_stamp: 'updated_at',
  },
  custom_fields: { type: 'data_type', uom: 'unit_of_measure' },
  custom_field_choices: {},
  customer_custom_field_values: {
    type: 'data_type',
    value: 'value_text',
    value_raw: 'value_text',
    choice_id: 'custom_field_choice_id',
    time_stamp: 'updated_at',
  },
  customer_notes: { time_stamp: 'noted_at', updated_at: 'noted_at' },
};

/**
 * Money/cost columns that feed measures rather than mapping to a same-named
 * member: column -> the measure that consumes it. The measure's existence is
 * verified against /v1/meta.
 */
const CONSUMED_BY = {
  sales: {
    calc_total: 'gross_takings',
    calc_subtotal: 'net_sales_ex_tax',
    calc_taxable: 'taxable_amount',
    calc_non_taxable: 'non_taxable_amount',
    calc_discount: 'discounts_given',
    calc_tax1: 'tax1_collected',
    calc_tax2: 'tax2_collected',
    calc_payments: 'payments_received',
    calc_tips: 'tips_collected',
    calc_avg_cost: 'cost_of_goods',
    calc_fifo_cost: 'cost_of_goods',
  },
  sale_lines: {
    calc_total: 'line_revenue',
    calc_subtotal: 'line_net_revenue',
    calc_tax1: 'line_tax',
    calc_tax2: 'line_tax',
    calc_line_discount: 'line_discounts',
    calc_transaction_discount: 'line_discounts',
    avg_cost: 'line_cost_of_goods',
    fifo_cost: 'line_cost_of_goods',
  },
  sale_payments: {
    amount: 'tender_total',
    tip_amount: 'tips_total',
  },
  processing_fees: {
    interchange_fees_fixed_fee: 'interchange_fees',
    interchange_fees_variable_fee: 'interchange_fees',
    scheme_fees_fixed_fee: 'scheme_fees',
    scheme_fees_variable_fee: 'scheme_fees',
  },
};

/** Per-cube column exclusions beyond the universal plumbing set. */
const COLUMN_EXCLUSIONS = {
  sales: {},
  items: {
    tax_class: 'raw jsonb blob; tax class is modelled via the tax_classes join',
    note: 'raw jsonb note blob; not analytical',
    custom_field_values: 'raw jsonb blob; item custom fields are out of the sales/customers domain',
  },
  customers: {
    contact_json: 'raw jsonb blob; contact data is modelled via the contacts join',
    custom_field_values_json: 'raw jsonb blob; modelled through customer_custom_field_values',
  },
  contacts: {
    owner_object: 'vendor back-reference; not present in the staging DDL projection',
    owner_id: 'vendor back-reference; not present in the staging DDL projection',
  },
  shops: {
    contact: 'raw jsonb blob; shop address not needed for sales/customer analytics',
  },
  employees: {
    contact: 'raw jsonb blob; staff contact details not analytical',
  },
  ship_tos: {
    contact_json: 'raw jsonb blob; destination address is modelled via the contacts join',
  },
  custom_fields: {
    default_value: 'raw jsonb default value; definition metadata only',
    decimal_precision: 'display formatting metadata, not analytical',
  },
  custom_field_choices: {
    can_be_deleted: 'admin UI metadata, not analytical',
    updated_at: 'modification timestamp of admin metadata; not analytical',
  },
};

async function main() {
  const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
  const shopifyRegistry = JSON.parse(fs.readFileSync(SHOPIFY_REGISTRY, 'utf8'));
  const token = signJwt(
    {
      tenant_id: process.env.TENANT_ID || '01KZ4ZMVF5QNQ4TX35VF3WDJBM',
      conversation_id: '01SM0KETESTC0NVAAAAAAAAAAA',
      turn_id: '01SM0KETESTT0RNAAAAAAAAAAA',
    },
    API_SECRET,
  );
  const res = await fetch(`${CUBE_URL}/cubejs-api/v1/meta`, { headers: { Authorization: token } });
  if (res.status !== 200) {
    console.error('meta fetch failed', res.status, await res.text());
    process.exit(1);
  }
  const meta = await res.json();
  const membersByCube = new Map(
    meta.cubes.map((c) => [
      c.name,
      new Set(
        [...c.measures, ...c.dimensions, ...(c.segments || [])].map((m) => m.name.split('.')[1]),
      ),
    ]),
  );

  const domainTables = catalogue.tables.filter((t) => ['sales', 'customers'].includes(t.domain));
  const report = [];
  let unexplained = 0;

  for (const [table, cube] of Object.entries(SHOPIFY_TABLE_TO_CUBE)) {
    if (!membersByCube.has(cube)) {
      report.push({ table, status: 'UNEXPLAINED SHOPIFY CUBE GAP', expectedMember: cube });
      unexplained += 1;
    }
  }
  const exhaustiveMembers = membersByCube.get('shopify_fields');
  if (exhaustiveMembers) {
    for (const member of SHOPIFY_EXHAUSTIVE_MEMBERS) {
      if (!exhaustiveMembers.has(member)) {
        report.push({
          table: 'shopify_fields',
          column: member,
          status: 'UNEXPLAINED SHOPIFY FALLBACK GAP',
          expectedMember: member,
        });
        unexplained += 1;
      }
    }
  }

  for (const table of domainTables) {
    if (EXCLUDED_TABLES[table.id]) {
      report.push({ table: table.id, status: 'table excluded', reason: EXCLUDED_TABLES[table.id] });
      continue;
    }
    const cubeName = TABLE_TO_CUBE[table.id];
    if (!cubeName) {
      report.push({ table: table.id, status: 'UNEXPLAINED TABLE GAP' });
      unexplained += 1;
      continue;
    }
    const members = membersByCube.get(cubeName);
    if (!members) {
      report.push({ table: table.id, status: `cube ${cubeName} missing from meta` });
      unexplained += table.columns.length;
      continue;
    }
    const renames = RENAMES[cubeName] || {};
    const exclusions = COLUMN_EXCLUSIONS[cubeName] || {};
    const consumed = CONSUMED_BY[cubeName] || {};
    for (const col of table.columns) {
      const name = col.name;
      if (UNIVERSAL_EXCLUSIONS[name]) continue;
      if (exclusions[name]) continue;
      const member = consumed[name] || renames[name] || name;
      if (!members.has(member)) {
        report.push({ table: table.id, column: name, status: 'UNEXPLAINED COLUMN GAP', expectedMember: member });
        unexplained += 1;
      }
    }
  }

  const modelled = domainTables.filter((t) => TABLE_TO_CUBE[t.id]).length;
  const excluded = domainTables.filter((t) => EXCLUDED_TABLES[t.id]).length;
  console.log(`Sales/customers playbook tables: ${domainTables.length} (${modelled} modelled, ${excluded} excluded with reasons)`);
  console.log(
    `Shopify Admin GraphQL ${shopifyRegistry.apiVersion}: ` +
    `${Object.keys(SHOPIFY_TABLE_TO_CUBE).length} normalized streams projected; ` +
    `${shopifyRegistry.counts.fields.toLocaleString()} schema fields addressable through shopify_fields`,
  );
  for (const row of report) {
    if (row.status.startsWith('UNEXPLAINED')) {
      console.log(`GAP   ${row.table}${row.column ? '.' + row.column : ''}  expected member: ${row.expectedMember || 'n/a'}`);
    } else {
      console.log(`SKIP  ${row.table}  ${row.reason || row.status}`);
    }
  }
  if (unexplained > 0) {
    console.log(`\nFAIL: ${unexplained} unexplained coverage gaps.`);
    process.exit(1);
  }
  console.log(
    '\nPASS: every playbook column is mapped or explicitly excluded, and every ' +
    'Shopify stream plus the governed exhaustive-field contract is present.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
