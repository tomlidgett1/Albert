import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type StagingColumnContract = Readonly<{
  name: string;
  dataType: string;
  nullable: boolean;
  sourceMigration: string;
}>;

export type StagingTableContract = Readonly<{
  schema: "source_lightspeed" | "source_xero";
  table: string;
  columns: ReadonlyMap<string, StagingColumnContract>;
}>;

export const STAGING_PLATFORM_COLUMNS = new Set([
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

/**
 * Semantic Lightspeed field name -> physical staging candidates.
 *
 * The connector catalogue deliberately uses stable, descriptive semantic
 * names. The typed staging schema predates some of those names. These aliases
 * are therefore part of the governed storage contract rather than fuzzy
 * matching performed at query time.
 */
const LIGHTSPEED_GLOBAL_ALIASES: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
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
  full_name: [],
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
  cost_level_2: ["cost_level2"],
  cost_level_3: ["cost_level3"],
  cost_level_4: ["cost_level4"],
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
  ship_cost_vendor_currency: ["ship_vendor_cost"],
  other_cost_vendor_currency: ["other_vendor_cost"],
  shipping_cost_vendor_currency: ["shipping_vendor_cost"],
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

const LIGHTSPEED_TABLE_ALIASES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = Object.freeze({
  ls_sales: {
    update_time: ["updatetime"],
    change_given: ["change"],
  },
  ls_sale_lines: {
    taxed: ["tax"],
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
  ls_item_prices: { item_description: [], item_archived: [] },
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
    expected_arrival_at: ["arrival_date"],
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
    shipping_cost_vendor_currency: ["shipping_vendor_cost"],
  },
  ls_workorders: {
    customer_name: ["customer"],
    status_name: ["name"],
    status_system_value: ["system_value"],
    item_description: ["description"],
    item_serial: ["serial"],
    updated_at: ["time_stamp"],
  },
  ls_registers: { is_open: ["open"], opened_at: ["open_time"] },
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
  ls_contact_emails: { entry_index: ["contact_email"] },
  ls_contact_phones: { entry_index: ["contact_phone"] },
  ls_contact_websites: { entry_index: ["contact_website"] },
  ls_customer_custom_field_values: {
    value_raw: ["value"],
    value_text: [],
    choice_id: ["custom_field_choice_id"],
  },
  ls_currency_denominations: { value: ["currency_denominations"] },
  ls_report_payments_by_day: { day: ["date"], is_layaway: ["layaway"] },
  ls_report_taxes_by_day: { day: ["date"], tax_amount: ["tax"] },
  ls_report_discounts_by_day: {
    day: ["date"],
    discount_amount: ["discount"],
  },
  ls_report_tax_class_sales_by_day: { day: ["date"] },
  ls_report_orders_by_tax_class: { received_date: ["date"] },
  ls_register_calculated: {
    register_id: ["register_calculated_path_parameter_register_id"],
    payment_total: ["payment"],
    add_total: ["add"],
    withdraw_total: ["withdraw"],
  },
});

export function lightspeedPhysicalCandidates(
  table: string,
  semanticName: string,
): readonly string[] {
  const tableCandidates = LIGHTSPEED_TABLE_ALIASES[table]?.[semanticName];
  return tableCandidates ?? LIGHTSPEED_GLOBAL_ALIASES[semanticName] ?? [];
}

export function normalizePostgresDataType(type: string): string {
  const normalized = type.trim().toLowerCase().replace(/\s+/gu, " ");
  if (normalized === "timestamptz") return "timestamp with time zone";
  if (normalized === "timestamp") return "timestamp without time zone";
  if (/^numeric(?:\s*\([^)]*\))?$/u.test(normalized)) return "numeric";
  if (/^decimal(?:\s*\([^)]*\))?$/u.test(normalized)) return "numeric";
  if (/^(?:varchar|character varying)(?:\s*\([^)]*\))?$/u.test(normalized))
    return "character varying";
  if (/^(?:char|character)(?:\s*\([^)]*\))?$/u.test(normalized))
    return "character";
  if (normalized === "int" || normalized === "int4") return "integer";
  if (normalized === "int8") return "bigint";
  if (normalized === "int2") return "smallint";
  if (normalized.endsWith("[]")) return "ARRAY";
  return normalized;
}

/** PostgreSQL stores identifiers at no more than NAMEDATALEN - 1 bytes. */
export function postgresPhysicalIdentifier(identifier: string): string {
  // Connector and semantic identifiers are constrained to ASCII, so the byte
  // and JavaScript code-unit boundaries are identical here.
  return identifier.slice(0, 63);
}

function parseColumnDefinition(
  line: string,
  sourceMigration: string,
): StagingColumnContract | null {
  const match = line.match(
    /^\s*(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s+(.+?)\s*,?\s*$/u,
  );
  if (!match) return null;
  const name = postgresPhysicalIdentifier(match[1] ?? match[2]!);
  if (
    ["PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT", "EXCLUDE"].includes(
      name.toUpperCase(),
    )
  )
    return null;
  const remainder = match[3]!;
  const type = remainder.match(
    /^(timestamptz|timestamp(?:\s+(?:with|without)\s+time\s+zone)?|double\s+precision|character\s+varying(?:\s*\([^)]*\))?|varchar(?:\s*\([^)]*\))?|character(?:\s*\([^)]*\))?|char(?:\s*\([^)]*\))?|numeric(?:\s*\([^)]*\))?|decimal(?:\s*\([^)]*\))?|[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)/iu,
  )?.[1];
  if (!type) return null;
  return {
    name,
    dataType: normalizePostgresDataType(type),
    nullable: !/\bNOT\s+NULL\b/iu.test(remainder),
    sourceMigration,
  };
}

/** Parse the repository migrations as the expected physical staging contract. */
export function parseStagingContractsFromMigrations(
  directory: string,
): ReadonlyMap<string, StagingTableContract> {
  const mutable = new Map<
    string,
    {
      schema: "source_lightspeed" | "source_xero";
      table: string;
      columns: Map<string, StagingColumnContract>;
    }
  >();
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const tablePattern =
    /"?(source_lightspeed|source_xero)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/u;

  for (const file of files) {
    const sql = readFileSync(join(directory, file), "utf8");
    const create =
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+("?(?:source_lightspeed|source_xero)"?\."?[A-Za-z_][A-Za-z0-9_]*"?)\s*\(([\s\S]*?)\n\);/giu;
    for (const match of sql.matchAll(create)) {
      const tableMatch = match[1]!.match(tablePattern);
      if (!tableMatch) continue;
      const schema = tableMatch[1]! as "source_lightspeed" | "source_xero";
      const table = tableMatch[2]!;
      const key = `${schema}.${table}`;
      const contract = mutable.get(key) ?? {
        schema,
        table,
        columns: new Map<string, StagingColumnContract>(),
      };
      for (const line of match[2]!.split("\n")) {
        const column = parseColumnDefinition(line, file);
        // CREATE IF NOT EXISTS cannot change an already-created physical
        // column, so the earliest declaration remains authoritative.
        if (column && !contract.columns.has(column.name))
          contract.columns.set(column.name, column);
      }
      mutable.set(key, contract);
    }

    const alter =
      /ALTER\s+TABLE\s+("?(?:source_lightspeed|source_xero)"?\."?[A-Za-z_][A-Za-z0-9_]*"?)\s+([\s\S]*?);/giu;
    for (const match of sql.matchAll(alter)) {
      const tableMatch = match[1]!.match(tablePattern);
      if (!tableMatch) continue;
      const schema = tableMatch[1]! as "source_lightspeed" | "source_xero";
      const table = tableMatch[2]!;
      const key = `${schema}.${table}`;
      const contract = mutable.get(key) ?? {
        schema,
        table,
        columns: new Map<string, StagingColumnContract>(),
      };
      const additions =
        /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+((?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)\s+[^,;]+)/giu;
      for (const addition of match[2]!.matchAll(additions)) {
        const column = parseColumnDefinition(addition[1]!, file);
        if (column && !contract.columns.has(column.name))
          contract.columns.set(column.name, column);
      }
      mutable.set(key, contract);
    }
  }

  return mutable;
}

export function resolvePhysicalStagingColumn(args: Readonly<{
  connector: "lightspeed" | "xero";
  table: string;
  semanticName: string;
  columns: ReadonlyMap<string, StagingColumnContract>;
}>): StagingColumnContract | null {
  const exact = args.columns.get(postgresPhysicalIdentifier(args.semanticName));
  if (exact) return exact;
  if (args.connector === "xero") return null;
  for (const candidate of lightspeedPhysicalCandidates(
    args.table,
    args.semanticName,
  )) {
    const physical = args.columns.get(postgresPhysicalIdentifier(candidate));
    if (physical) return physical;
  }
  return null;
}
