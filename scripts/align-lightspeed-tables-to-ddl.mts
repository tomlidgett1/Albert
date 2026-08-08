/**
 * Align connectors/lightspeed-r/tables.json column names to the live staging DDL.
 *
 * Source of truth for executable columns: infra/migrations/analytical/0121_m2_lightspeed_full_staging.sql
 * tables.json keeps descriptions / api provenance, but `name` must match the database
 * or the agent invents columns that throw at runtime.
 *
 * Usage: npx tsx scripts/align-lightspeed-tables-to-ddl.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION = resolve("infra/migrations/analytical/0121_m2_lightspeed_full_staging.sql");
const TABLES_PATH = resolve("connectors/lightspeed-r/tables.json");

const PLATFORM = new Set([
  "tenant_id",
  "namespaced_source_key",
  "connection_id",
  "external_account_reference",
  "source_record_id",
  "source_version",
  "source_updated_at",
  "payload_hash",
  "payload_batch_id",
  "sync_run_id",
  "tombstone",
  "mapping_version",
  "first_ingested_at",
  "ingested_at",
]);

/** Global renames tried when a declared column is missing from DDL. */
const GLOBAL_RENAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  created_at: ["create_time", "create_date", "time_in"],
  updated_at: ["time_stamp", "updatetime", "update_time"],
  update_time: ["updatetime"],
  change_given: ["change"],
  taxable: ["tax"],
  taxed: ["tax"],
  item_archived: ["archived"],
  is_archived: ["archived"],
  is_complete: ["complete"],
  is_sent: ["sent"],
  is_received: ["received"],
  is_open: ["open"],
  is_layaway: ["layaway"],
  ordered_at: ["ordered_date"],
  received_at: ["received_date", "reception_date"],
  expected_arrival_at: ["expected_arrival_date"],
  sent_at: ["sent_on", "sent_date"],
  closed_at: ["create_time"],
  opened_at: ["open_time"],
  counted_at: ["time_stamp", "create_time"],
  reconciled_at: ["time_stamp", "create_time"],
  ref_number: ["ref_num"],
  vendor_name: ["name"],
  customer_name: ["customer"],
  status_name: ["name"],
  status_system_value: ["system_value"],
  item_description: ["description"],
  item_serial: ["serial"],
  full_name: [], // composite — drop; use first_name + last_name
  category_name: [],
  category_full_path_name: [],
  manufacturer_name: [],
  season_name: [],
  attribute_set_name: [],
  from_shop_id: ["shop_id"],
  to_shop_id: ["to_shop_id"],
  sent_by_employee_id: ["employee_id"],
  received_by_employee_id: ["employee_id"],
  day: ["date"],
  tax_amount: ["tax"],
  discount_amount: ["discount"],
  unit_cost: ["price"],
  unit_cost_original: ["original_price"],
  unit_cost_vendor_currency: ["vendor_cost"],
  qty_checked_in: ["checked_in"],
  qty_received_not_checked_in: ["num_received"],
  line_total: ["total"],
  price: ["amount_where_use_type_default"],
  msrp: ["amount_where_use_type_msrp"],
  attribute_1: ["attribute1"],
  attribute_2: ["attribute2"],
  attribute_3: ["attribute3"],
  attribute_name_1: ["attribute_name1"],
  attribute_name_2: ["attribute_name2"],
  attribute_name_3: ["attribute_name3"],
  tax_class_json: ["tax_class"],
  note_json: ["note"],
  custom_field_values_json: ["custom_field_values"],
  contact_json: ["contact"],
  department_json: ["department"],
  calculation_json: ["calculation"],
  item_fee_categories_json: ["item_fee_categories"],
  catalog_vendor_json: ["catalog_vendor"],
  currency_denominations_json: ["currency_denominations"],
  ecom_item_ecommerce_id: ["item_e_commerce_id"],
  ecom_long_description: ["long_description"],
  ecom_short_description: ["short_description"],
  ecom_list_on_store: ["list_on_store"],
  default_value: ["default"],
  value_raw: ["value"],
  value_text: ["value"],
  email_address: ["address"],
  phone_number: ["number"],
  entry_index: ["idx"],
  owner_object: ["owner_type"],
  owner_id: ["owner_id"],
  cost_level_2: ["cost2"],
  cost_level_3: ["cost3"],
  cost_level_4: ["cost4"],
  break_qty_2: ["break_qty2"],
  break_price_2: ["break_price2"],
  break_qty_3: ["break_qty3"],
  break_price_3: ["break_price3"],
  purchasing_currency_code: ["code"],
  purchasing_currency_symbol: ["symbol"],
  purchasing_currency_rate: ["rate"],
  default_currency_code: ["code"],
  default_currency_symbol: ["symbol"],
  currency_code: ["code"],
  currency_symbol: ["symbol"],
  ship_cost_vendor_currency: ["ship_cost"],
  other_cost_vendor_currency: ["other_cost"],
  shipping_cost_vendor_currency: ["shipping_cost"],
  discount_percent_legacy: ["discount_percent"],
  vendor_sku: ["value"],
  tax1_rate_override: ["tax1_rate"],
  tax2_rate_override: ["tax2_rate"],
  register_id: ["register_id"],
  payment_total: ["payments"],
  add_total: ["adds"],
  withdraw_total: ["withdraws"],
  value: ["amount"],
});

/** Per-table overrides tried before GLOBAL_RENAMES. */
const TABLE_RENAMES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  ls_sales: {
    update_time: ["updatetime"],
    change_given: ["change"],
  },
  ls_sale_lines: {
    taxed: ["tax"],
    // sale-line rows do not carry header completion flags in staging
    completed: [],
    voided: [],
    complete_time: [],
  },
  ls_sale_payments: {
    completed: [],
    voided: [],
    complete_time: [],
    shop_id: [],
  },
  ls_items: {
    taxable: ["tax"],
    updated_at: ["time_stamp"],
    created_at: ["create_time"],
    price: ["amount_where_use_type_default"],
    msrp: ["amount_where_use_type_msrp"],
  },
  ls_item_prices: {
    item_description: [],
    item_archived: [],
  },
  ls_item_fees: {
    updated_at: ["timestamp"],
    created_at: ["create_time"],
    item_fee_categories_json: ["item_fee_categories"],
  },
  ls_item_vendor_nums: {
    vendor_sku: ["value"],
    updated_at: ["time_stamp"],
  },
  ls_transfers: {
    is_sent: ["sent"],
    is_received: ["received"],
    from_shop_id: ["shop_id"],
    to_shop_id: [],
    sent_by_employee_id: ["employee_id"],
    received_by_employee_id: [],
    updated_at: ["time_stamp"],
  },
  ls_purchase_orders: {
    is_complete: ["complete"],
    is_archived: ["archived"],
    ordered_at: ["ordered_date"],
    received_at: ["received_date"],
    expected_arrival_at: ["expected_arrival_date"],
    ref_number: ["ref_num"],
    vendor_name: ["name"],
    created_at: ["create_time"],
    updated_at: ["time_stamp"],
  },
  ls_purchase_order_lines: {
    unit_cost: ["price"],
    unit_cost_original: ["original_price"],
    unit_cost_vendor_currency: ["vendor_cost"],
    qty_checked_in: ["checked_in"],
    qty_received_not_checked_in: ["num_received"],
    line_total: ["total"],
    created_at: ["create_time"],
    updated_at: ["time_stamp"],
    vendor_id: [],
    shop_id: [],
    complete: [],
    ordered_date: [],
    received_date: [],
    archived: [],
    vendor_currency_code: [],
    shipping_cost_vendor_currency: ["shipping_cost"],
  },
  ls_workorders: {
    customer_name: ["customer"],
    status_name: ["name"],
    status_system_value: ["system_value"],
    item_description: ["description"],
    item_serial: ["serial"],
    updated_at: ["time_stamp"],
  },
  ls_registers: {
    is_open: ["open"],
    opened_at: ["open_time"],
  },
  ls_register_counts: {
    closed_at: ["create_time"],
    opened_at: ["open_time"],
  },
  ls_employees: {
    full_name: [],
    updated_at: ["time_stamp"],
    contact_json: ["contact"],
  },
  ls_customers: {
    full_name: [],
    updated_at: ["time_stamp"],
    contact_json: ["contact"],
    custom_field_values_json: ["custom_field_values"],
  },
  ls_report_payments_by_day: {
    day: ["date"],
    is_layaway: ["layaway"],
  },
  ls_report_taxes_by_day: {
    day: ["date"],
    tax_amount: ["tax"],
  },
  ls_report_discounts_by_day: {
    day: ["date"],
    discount_amount: ["discount"],
  },
  ls_report_tax_class_sales_by_day: {
    day: ["date"],
  },
  ls_report_orders_by_tax_class: {
    received_date: ["date"],
  },
  ls_register_calculated: {
    register_id: [],
    payment_total: ["payments"],
    add_total: ["adds"],
    withdraw_total: ["withdraws"],
  },
});

type SpecColumn = {
  name: string;
  type?: string;
  api?: string;
  description?: string;
  key?: boolean;
  pii?: boolean;
  loadBearing?: boolean;
  deprecated?: boolean;
  enums?: string | null;
  [key: string]: unknown;
};

type SpecTable = {
  id: string;
  columns: SpecColumn[];
  pushdowns?: Array<{ column: string; param: string; sortable?: boolean }>;
  primaryKey?: string[];
  gotchas?: string[];
  [key: string]: unknown;
};

function parseDdlColumns(sql: string): Map<string, Set<string>> {
  const db = new Map<string, Set<string>>();
  const re = /CREATE TABLE IF NOT EXISTS "source_lightspeed"\."(\w+)"\s*\(([\s\S]*?)\n\);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql))) {
    const cols = [...match[2].matchAll(/^\s*"([a-zA-Z_][a-zA-Z0-9_]*)"\s+/gm)].map((x) => x[1]!);
    db.set(match[1]!, new Set(cols.filter((c) => !PLATFORM.has(c))));
  }
  return db;
}

function candidates(tableId: string, column: string): readonly string[] {
  const table = TABLE_RENAMES[tableId]?.[column];
  if (table) return table;
  return GLOBAL_RENAMES[column] ?? [];
}

function rewriteText(text: string, renames: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [from, to] of renames) {
    if (from === to) continue;
    out = out.replaceAll(from, to);
  }
  return out;
}

const sql = readFileSync(MIGRATION, "utf8");
const ddl = parseDdlColumns(sql);
const pack = JSON.parse(readFileSync(TABLES_PATH, "utf8")) as {
  generatedFrom?: string;
  tableCount?: number;
  tables: SpecTable[];
};

const summary = {
  tables: 0,
  renamed: [] as string[],
  dropped: [] as string[],
  pushdownFixed: 0,
  remainingDrift: [] as string[],
};

for (const table of pack.tables) {
  summary.tables += 1;
  const live = ddl.get(table.id);
  if (!live) {
    summary.remainingDrift.push(`${table.id}: missing from migration`);
    continue;
  }

  const used = new Set<string>();
  const nextColumns: SpecColumn[] = [];
  const renames = new Map<string, string>();

  for (const column of table.columns ?? []) {
    if (live.has(column.name)) {
      if (used.has(column.name)) continue;
      used.add(column.name);
      nextColumns.push(column);
      continue;
    }

    const options = candidates(table.id, column.name);
    const hit = options.find((name) => live.has(name) && !used.has(name));
    if (hit) {
      summary.renamed.push(`${table.id}.${column.name}→${hit}`);
      renames.set(column.name, hit);
      used.add(hit);
      nextColumns.push({
        ...column,
        name: hit,
        description: column.description
          ? `${column.description} (staging column: ${hit})`
          : column.description,
      });
      continue;
    }

    summary.dropped.push(`${table.id}.${column.name}`);
    renames.set(column.name, "");
  }

  // Ensure every live load-bearing-ish column appears if it was missing entirely.
  // Only add columns that look like identifiers or common measures when absent.
  for (const liveCol of [...live].sort()) {
    if (used.has(liveCol)) continue;
    // Skip adding every obscure column; prefer ones the agent actually needs.
    const important = /(_id$|^qoh$|archived|complete|voided|time_stamp|create_time|complete_time|description|name|calc_|avg_cost|tax$|open$|sent$|received$)/u.test(liveCol);
    if (!important) continue;
    nextColumns.push({
      name: liveCol,
      type: "text",
      api: liveCol,
      description: `Staging column present in live DDL (${liveCol}).`,
      key: /_id$/u.test(liveCol),
      pii: false,
      loadBearing: important,
      deprecated: false,
      enums: null,
    });
    used.add(liveCol);
    summary.renamed.push(`${table.id}.(+${liveCol})`);
  }

  table.columns = nextColumns;

  if (Array.isArray(table.pushdowns)) {
    table.pushdowns = table.pushdowns.flatMap((push) => {
      if (live.has(push.column)) return [push];
      const mapped = renames.get(push.column);
      if (mapped && live.has(mapped)) {
        summary.pushdownFixed += 1;
        return [{ ...push, column: mapped }];
      }
      const hit = candidates(table.id, push.column).find((name) => live.has(name));
      if (hit) {
        summary.pushdownFixed += 1;
        return [{ ...push, column: hit }];
      }
      summary.pushdownFixed += 1;
      return [];
    });
  }

  if (Array.isArray(table.primaryKey)) {
    table.primaryKey = table.primaryKey.map((key) => {
      if (live.has(key)) return key;
      return renames.get(key) || candidates(table.id, key).find((name) => live.has(name)) || key;
    });
  }

  if (Array.isArray(table.gotchas)) {
    table.gotchas = table.gotchas.map((g) => rewriteText(g, new Map([...renames].filter(([, to]) => to))));
  }

  for (const column of table.columns) {
    if (!live.has(column.name)) {
      summary.remainingDrift.push(`${table.id}.${column.name}`);
    }
  }
}

pack.tableCount = pack.tables.length;
writeFileSync(TABLES_PATH, `${JSON.stringify(pack, null, 2)}\n`);
writeFileSync(
  resolve(".albert-lightspeed-schema-align-report.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);

console.log(JSON.stringify({
  tables: summary.tables,
  renamed: summary.renamed.length,
  dropped: summary.dropped.length,
  pushdownFixed: summary.pushdownFixed,
  remainingDrift: summary.remainingDrift.length,
  remainingSample: summary.remainingDrift.slice(0, 30),
  droppedSample: summary.dropped.slice(0, 40),
  renamedSample: summary.renamed.slice(0, 40),
}, null, 2));
