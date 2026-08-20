import { dump, load } from "js-yaml";
import { ALBERT_V3_AGENT_CONFIG } from "@/packages/albert-v3/src/agent-config/generated-agent-config";
import { isInternalOperator } from "@/services/control-plane/src/operator-repository";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

import cashManagementCubes from "@/cube-playground/model/cubes/cash_management.yml?raw";
import customersCubes from "@/cube-playground/model/cubes/customers.yml?raw";
import deputyWorkforceCubes from "@/cube-playground/model/cubes/deputy_workforce.yml?raw";
import inventoryCubes from "@/cube-playground/model/cubes/inventory.yml?raw";
import lightspeedXCommerceCubes from "@/cube-playground/model/cubes/lightspeed_x_commerce.yml?raw";
import lightspeedXCustomersCubes from "@/cube-playground/model/cubes/lightspeed_x_customers.yml?raw";
import lightspeedXOperationsCubes from "@/cube-playground/model/cubes/lightspeed_x_operations.yml?raw";
import lightspeedXReferenceCubes from "@/cube-playground/model/cubes/lightspeed_x_reference.yml?raw";
import lightspeedXSourceExplorerCubes from "@/cube-playground/model/cubes/lightspeed_x_source_explorer.yml?raw";
import momenceCommerceCubes from "@/cube-playground/model/cubes/momence_commerce.yml?raw";
import momenceMembershipsCubes from "@/cube-playground/model/cubes/momence_memberships.yml?raw";
import momenceOperationsCubes from "@/cube-playground/model/cubes/momence_operations.yml?raw";
import momenceReferenceCubes from "@/cube-playground/model/cubes/momence_reference.yml?raw";
import momenceSourceExplorerCubes from "@/cube-playground/model/cubes/momence_source_explorer.yml?raw";
import organisationCubes from "@/cube-playground/model/cubes/organisation.yml?raw";
import productEnrichmentCubes from "@/cube-playground/model/cubes/product_enrichment.yml?raw";
import productsCubes from "@/cube-playground/model/cubes/products.yml?raw";
import purchasingCubes from "@/cube-playground/model/cubes/purchasing.yml?raw";
import saleLinesCubes from "@/cube-playground/model/cubes/sale_lines.yml?raw";
import salePaymentsCubes from "@/cube-playground/model/cubes/sale_payments.yml?raw";
import salesCubes from "@/cube-playground/model/cubes/sales.yml?raw";
import salesEventsCubes from "@/cube-playground/model/cubes/sales_events.yml?raw";
import shopifyCommerceCubes from "@/cube-playground/model/cubes/shopify_commerce.yml?raw";
import shopifyReferenceCubes from "@/cube-playground/model/cubes/shopify_reference.yml?raw";
import squareCommerceCubes from "@/cube-playground/model/cubes/square_commerce.yml?raw";
import squareEfficiencyCubes from "@/cube-playground/model/cubes/square_efficiency.yml?raw";
import squareFinanceCubes from "@/cube-playground/model/cubes/square_finance.yml?raw";
import squareOperationsCubes from "@/cube-playground/model/cubes/square_operations.yml?raw";
import squareSourceExplorerCubes from "@/cube-playground/model/cubes/square_source_explorer.yml?raw";
import staffCubes from "@/cube-playground/model/cubes/staff.yml?raw";
import workshopCubes from "@/cube-playground/model/cubes/workshop.yml?raw";
import xeroAccountingCubes from "@/cube-playground/model/cubes/xero_accounting.yml?raw";
import xeroReportsCubes from "@/cube-playground/model/cubes/xero_reports.yml?raw";
import xeroPayrollCubes from "@/cube-playground/model/cubes/xero_payroll.yml?raw";
import xeroReferenceCubes from "@/cube-playground/model/cubes/xero_reference.yml?raw";

import cashManagementViews from "@/cube-playground/model/views/cash_management_analytics.yml?raw";
import customerViews from "@/cube-playground/model/views/customer_analytics.yml?raw";
import inventoryViews from "@/cube-playground/model/views/inventory_analytics.yml?raw";
import lightspeedXCatalogueViews from "@/cube-playground/model/views/lightspeed_x_catalogue_analytics.yml?raw";
import lightspeedXCommerceViews from "@/cube-playground/model/views/lightspeed_x_commerce_analytics.yml?raw";
import lightspeedXCustomerViews from "@/cube-playground/model/views/lightspeed_x_customer_analytics.yml?raw";
import lightspeedXInventoryViews from "@/cube-playground/model/views/lightspeed_x_inventory_analytics.yml?raw";
import lightspeedXOperationsViews from "@/cube-playground/model/views/lightspeed_x_operations_analytics.yml?raw";
import lightspeedXSourceExplorerViews from "@/cube-playground/model/views/lightspeed_x_source_explorer.yml?raw";
import momenceViews from "@/cube-playground/model/views/momence_analytics.yml?raw";
import paymentsViews from "@/cube-playground/model/views/payments_analytics.yml?raw";
import productSalesViews from "@/cube-playground/model/views/product_sales_analytics.yml?raw";
import purchasingViews from "@/cube-playground/model/views/purchasing_analytics.yml?raw";
import salesViews from "@/cube-playground/model/views/sales_analytics.yml?raw";
import shopifyViews from "@/cube-playground/model/views/shopify_analytics.yml?raw";
import squareCashActivityViews from "@/cube-playground/model/views/square_cash_activity_analytics.yml?raw";
import squareCashManagementViews from "@/cube-playground/model/views/square_cash_management_analytics.yml?raw";
import squareCatalogueViews from "@/cube-playground/model/views/square_catalogue_analytics.yml?raw";
import squareCustomerViews from "@/cube-playground/model/views/square_customer_analytics.yml?raw";
import squareDisputesViews from "@/cube-playground/model/views/square_disputes_analytics.yml?raw";
import squareGiftCardActivityViews from "@/cube-playground/model/views/square_gift_card_activity_analytics.yml?raw";
import squareGiftCardViews from "@/cube-playground/model/views/square_gift_card_analytics.yml?raw";
import squareInventoryActivityViews from "@/cube-playground/model/views/square_inventory_activity_analytics.yml?raw";
import squareInventoryViews from "@/cube-playground/model/views/square_inventory_analytics.yml?raw";
import squareLabourSalesViews from "@/cube-playground/model/views/square_labour_sales_analytics.yml?raw";
import squareLoyaltyActivityViews from "@/cube-playground/model/views/square_loyalty_activity_analytics.yml?raw";
import squareLoyaltyViews from "@/cube-playground/model/views/square_loyalty_analytics.yml?raw";
import squarePaymentsViews from "@/cube-playground/model/views/square_payments_analytics.yml?raw";
import squareProductSalesViews from "@/cube-playground/model/views/square_product_sales_analytics.yml?raw";
import squareRefundsViews from "@/cube-playground/model/views/square_refunds_analytics.yml?raw";
import squareRosterViews from "@/cube-playground/model/views/square_roster_analytics.yml?raw";
import squareSalesViews from "@/cube-playground/model/views/square_sales_analytics.yml?raw";
import squareSettlementsViews from "@/cube-playground/model/views/square_settlements_analytics.yml?raw";
import squareSourceExplorerViews from "@/cube-playground/model/views/square_source_explorer.yml?raw";
import squareWorkforceViews from "@/cube-playground/model/views/square_workforce_analytics.yml?raw";
import staffViews from "@/cube-playground/model/views/staff_analytics.yml?raw";
import workforceViews from "@/cube-playground/model/views/workforce_analytics.yml?raw";
import workshopViews from "@/cube-playground/model/views/workshop_analytics.yml?raw";
import xeroBusinessViews from "@/cube-playground/model/views/xero_business_analytics.yml?raw";
import xeroFinanceViews from "@/cube-playground/model/views/xero_finance_analytics.yml?raw";
import xeroPayrollViews from "@/cube-playground/model/views/xero_payroll_analytics.yml?raw";
import xeroProfitAndLossViews from "@/cube-playground/model/views/xero_profit_and_loss_analytics.yml?raw";
import xeroBalanceSheetViews from "@/cube-playground/model/views/xero_balance_sheet_analytics.yml?raw";

type ModelKind = "cube" | "view";
type AppId =
  | "lightspeed-r"
  | "lightspeed-x"
  | "deputy"
  | "xero"
  | "shopify"
  | "square"
  | "momence";

type ModelSource = Readonly<{
  kind: ModelKind;
  path: string;
  raw: string;
}>;

type RawEntry = Readonly<{
  kind: ModelKind;
  sourceFile: string;
  definition: Record<string, unknown>;
}>;

const MODEL_SOURCES = Object.freeze([
  { kind: "cube", path: "cube-playground/model/cubes/cash_management.yml", raw: cashManagementCubes },
  { kind: "cube", path: "cube-playground/model/cubes/customers.yml", raw: customersCubes },
  { kind: "cube", path: "cube-playground/model/cubes/deputy_workforce.yml", raw: deputyWorkforceCubes },
  { kind: "cube", path: "cube-playground/model/cubes/inventory.yml", raw: inventoryCubes },
  { kind: "cube", path: "cube-playground/model/cubes/lightspeed_x_commerce.yml", raw: lightspeedXCommerceCubes },
  { kind: "cube", path: "cube-playground/model/cubes/lightspeed_x_customers.yml", raw: lightspeedXCustomersCubes },
  { kind: "cube", path: "cube-playground/model/cubes/lightspeed_x_operations.yml", raw: lightspeedXOperationsCubes },
  { kind: "cube", path: "cube-playground/model/cubes/lightspeed_x_reference.yml", raw: lightspeedXReferenceCubes },
  { kind: "cube", path: "cube-playground/model/cubes/lightspeed_x_source_explorer.yml", raw: lightspeedXSourceExplorerCubes },
  { kind: "cube", path: "cube-playground/model/cubes/momence_commerce.yml", raw: momenceCommerceCubes },
  { kind: "cube", path: "cube-playground/model/cubes/momence_memberships.yml", raw: momenceMembershipsCubes },
  { kind: "cube", path: "cube-playground/model/cubes/momence_operations.yml", raw: momenceOperationsCubes },
  { kind: "cube", path: "cube-playground/model/cubes/momence_reference.yml", raw: momenceReferenceCubes },
  { kind: "cube", path: "cube-playground/model/cubes/momence_source_explorer.yml", raw: momenceSourceExplorerCubes },
  { kind: "cube", path: "cube-playground/model/cubes/organisation.yml", raw: organisationCubes },
  { kind: "cube", path: "cube-playground/model/cubes/product_enrichment.yml", raw: productEnrichmentCubes },
  { kind: "cube", path: "cube-playground/model/cubes/products.yml", raw: productsCubes },
  { kind: "cube", path: "cube-playground/model/cubes/purchasing.yml", raw: purchasingCubes },
  { kind: "cube", path: "cube-playground/model/cubes/sale_lines.yml", raw: saleLinesCubes },
  { kind: "cube", path: "cube-playground/model/cubes/sale_payments.yml", raw: salePaymentsCubes },
  { kind: "cube", path: "cube-playground/model/cubes/sales.yml", raw: salesCubes },
  { kind: "cube", path: "cube-playground/model/cubes/sales_events.yml", raw: salesEventsCubes },
  { kind: "cube", path: "cube-playground/model/cubes/shopify_commerce.yml", raw: shopifyCommerceCubes },
  { kind: "cube", path: "cube-playground/model/cubes/shopify_reference.yml", raw: shopifyReferenceCubes },
  { kind: "cube", path: "cube-playground/model/cubes/square_commerce.yml", raw: squareCommerceCubes },
  { kind: "cube", path: "cube-playground/model/cubes/square_efficiency.yml", raw: squareEfficiencyCubes },
  { kind: "cube", path: "cube-playground/model/cubes/square_finance.yml", raw: squareFinanceCubes },
  { kind: "cube", path: "cube-playground/model/cubes/square_operations.yml", raw: squareOperationsCubes },
  { kind: "cube", path: "cube-playground/model/cubes/square_source_explorer.yml", raw: squareSourceExplorerCubes },
  { kind: "cube", path: "cube-playground/model/cubes/staff.yml", raw: staffCubes },
  { kind: "cube", path: "cube-playground/model/cubes/workshop.yml", raw: workshopCubes },
  { kind: "cube", path: "cube-playground/model/cubes/xero_accounting.yml", raw: xeroAccountingCubes },
  { kind: "cube", path: "cube-playground/model/cubes/xero_reports.yml", raw: xeroReportsCubes },
  { kind: "cube", path: "cube-playground/model/cubes/xero_payroll.yml", raw: xeroPayrollCubes },
  { kind: "cube", path: "cube-playground/model/cubes/xero_reference.yml", raw: xeroReferenceCubes },
  { kind: "view", path: "cube-playground/model/views/cash_management_analytics.yml", raw: cashManagementViews },
  { kind: "view", path: "cube-playground/model/views/customer_analytics.yml", raw: customerViews },
  { kind: "view", path: "cube-playground/model/views/inventory_analytics.yml", raw: inventoryViews },
  { kind: "view", path: "cube-playground/model/views/lightspeed_x_catalogue_analytics.yml", raw: lightspeedXCatalogueViews },
  { kind: "view", path: "cube-playground/model/views/lightspeed_x_commerce_analytics.yml", raw: lightspeedXCommerceViews },
  { kind: "view", path: "cube-playground/model/views/lightspeed_x_customer_analytics.yml", raw: lightspeedXCustomerViews },
  { kind: "view", path: "cube-playground/model/views/lightspeed_x_inventory_analytics.yml", raw: lightspeedXInventoryViews },
  { kind: "view", path: "cube-playground/model/views/lightspeed_x_operations_analytics.yml", raw: lightspeedXOperationsViews },
  { kind: "view", path: "cube-playground/model/views/lightspeed_x_source_explorer.yml", raw: lightspeedXSourceExplorerViews },
  { kind: "view", path: "cube-playground/model/views/momence_analytics.yml", raw: momenceViews },
  { kind: "view", path: "cube-playground/model/views/payments_analytics.yml", raw: paymentsViews },
  { kind: "view", path: "cube-playground/model/views/product_sales_analytics.yml", raw: productSalesViews },
  { kind: "view", path: "cube-playground/model/views/purchasing_analytics.yml", raw: purchasingViews },
  { kind: "view", path: "cube-playground/model/views/sales_analytics.yml", raw: salesViews },
  { kind: "view", path: "cube-playground/model/views/shopify_analytics.yml", raw: shopifyViews },
  { kind: "view", path: "cube-playground/model/views/square_cash_activity_analytics.yml", raw: squareCashActivityViews },
  { kind: "view", path: "cube-playground/model/views/square_cash_management_analytics.yml", raw: squareCashManagementViews },
  { kind: "view", path: "cube-playground/model/views/square_catalogue_analytics.yml", raw: squareCatalogueViews },
  { kind: "view", path: "cube-playground/model/views/square_customer_analytics.yml", raw: squareCustomerViews },
  { kind: "view", path: "cube-playground/model/views/square_disputes_analytics.yml", raw: squareDisputesViews },
  { kind: "view", path: "cube-playground/model/views/square_gift_card_activity_analytics.yml", raw: squareGiftCardActivityViews },
  { kind: "view", path: "cube-playground/model/views/square_gift_card_analytics.yml", raw: squareGiftCardViews },
  { kind: "view", path: "cube-playground/model/views/square_inventory_activity_analytics.yml", raw: squareInventoryActivityViews },
  { kind: "view", path: "cube-playground/model/views/square_inventory_analytics.yml", raw: squareInventoryViews },
  { kind: "view", path: "cube-playground/model/views/square_labour_sales_analytics.yml", raw: squareLabourSalesViews },
  { kind: "view", path: "cube-playground/model/views/square_loyalty_activity_analytics.yml", raw: squareLoyaltyActivityViews },
  { kind: "view", path: "cube-playground/model/views/square_loyalty_analytics.yml", raw: squareLoyaltyViews },
  { kind: "view", path: "cube-playground/model/views/square_payments_analytics.yml", raw: squarePaymentsViews },
  { kind: "view", path: "cube-playground/model/views/square_product_sales_analytics.yml", raw: squareProductSalesViews },
  { kind: "view", path: "cube-playground/model/views/square_refunds_analytics.yml", raw: squareRefundsViews },
  { kind: "view", path: "cube-playground/model/views/square_roster_analytics.yml", raw: squareRosterViews },
  { kind: "view", path: "cube-playground/model/views/square_sales_analytics.yml", raw: squareSalesViews },
  { kind: "view", path: "cube-playground/model/views/square_settlements_analytics.yml", raw: squareSettlementsViews },
  { kind: "view", path: "cube-playground/model/views/square_source_explorer.yml", raw: squareSourceExplorerViews },
  { kind: "view", path: "cube-playground/model/views/square_workforce_analytics.yml", raw: squareWorkforceViews },
  { kind: "view", path: "cube-playground/model/views/staff_analytics.yml", raw: staffViews },
  { kind: "view", path: "cube-playground/model/views/workforce_analytics.yml", raw: workforceViews },
  { kind: "view", path: "cube-playground/model/views/workshop_analytics.yml", raw: workshopViews },
  { kind: "view", path: "cube-playground/model/views/xero_business_analytics.yml", raw: xeroBusinessViews },
  { kind: "view", path: "cube-playground/model/views/xero_finance_analytics.yml", raw: xeroFinanceViews },
  { kind: "view", path: "cube-playground/model/views/xero_payroll_analytics.yml", raw: xeroPayrollViews },
  { kind: "view", path: "cube-playground/model/views/xero_profit_and_loss_analytics.yml", raw: xeroProfitAndLossViews },
  { kind: "view", path: "cube-playground/model/views/xero_balance_sheet_analytics.yml", raw: xeroBalanceSheetViews },
] satisfies readonly ModelSource[]);

const APP_DEFINITIONS = Object.freeze([
  { id: "lightspeed-r", label: "Lightspeed R-Series", description: "Retail sales, products, inventory, customers, purchasing, cash and workshop operations." },
  { id: "lightspeed-x", label: "Lightspeed X-Series", description: "X-Series commerce, catalogue, customer, inventory and store operations." },
  { id: "deputy", label: "Deputy", description: "Rosters, timesheets, leave, employee reference data and labour cost." },
  { id: "xero", label: "Xero", description: "Accounting, business reference data and Australian payroll." },
  { id: "shopify", label: "Shopify", description: "Commerce, catalogue, fulfilment, returns, customers and privacy-bounded source fields." },
  { id: "square", label: "Square", description: "Commerce, payments, settlements, inventory, workforce, loyalty and gift cards." },
  { id: "momence", label: "Momence", description: "Studio members, schedules, attendance, memberships, payments and source exploration." },
] satisfies readonly Readonly<{ id: AppId; label: string; description: string }>[]);

const APP_ORDER = new Map(APP_DEFINITIONS.map(({ id }, index) => [id, index]));

const CONNECTOR_TO_APP: Readonly<Record<string, AppId>> = Object.freeze({
  lightspeed: "lightspeed-r",
  "lightspeed-r": "lightspeed-r",
  "lightspeed-x": "lightspeed-x",
  deputy: "deputy",
  xero: "xero",
  shopify: "shopify",
  square: "square",
  momence: "momence",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function basename(sourceFile: string): string {
  return sourceFile.slice(sourceFile.lastIndexOf("/") + 1);
}

function appForFile(sourceFile: string): AppId {
  const file = basename(sourceFile);
  if (file.startsWith("lightspeed_x_")) return "lightspeed-x";
  if (file.startsWith("deputy_") || file === "workforce_analytics.yml") return "deputy";
  if (file.startsWith("xero_")) return "xero";
  if (file.startsWith("shopify_")) return "shopify";
  if (file.startsWith("square_")) return "square";
  if (file.startsWith("momence_")) return "momence";
  return "lightspeed-r";
}

function parseEntries(): RawEntry[] {
  return MODEL_SOURCES.flatMap((source) => {
    const document = load(source.raw);
    if (!isRecord(document)) {
      throw new Error(`${source.path} does not contain a YAML object.`);
    }
    const key = source.kind === "cube" ? "cubes" : "views";
    const entries = recordArray(document[key]);
    if (entries.length === 0) {
      throw new Error(`${source.path} contains no ${key}.`);
    }
    return entries.map((definition) => ({
      kind: source.kind,
      sourceFile: source.path,
      definition,
    }));
  });
}

function memberSection(
  definition: Record<string, unknown>,
  section: "dimensions" | "measures" | "segments",
) {
  const kind = section.slice(0, -1);
  const cubeName = stringValue(definition.name) ?? "unknown_cube";
  return recordArray(definition[section]).map((member) => {
    const name = stringValue(member.name) ?? "unnamed";
    const meta = isRecord(member.meta) ? member.meta : {};
    return {
      id: `${cubeName}.${name}`,
      name,
      title: stringValue(member.title) ?? name,
      kind,
      type: stringValue(member.type),
      description: stringValue(member.description),
      aiContext: stringValue(meta.ai_context),
      sql: stringValue(member.sql),
      format: stringValue(member.format),
      public: typeof member.public === "boolean" ? member.public : null,
      primaryKey: member.primary_key === true,
      sourceCube: cubeName,
      sourcePath: cubeName,
      alias: null,
      resolved: true,
      properties: member,
    };
  });
}

function includedMember(value: unknown): Readonly<{ name: string; alias: string | null }> | null {
  if (typeof value === "string") return { name: value, alias: null };
  if (!isRecord(value)) return null;
  const name = stringValue(value.name);
  if (!name) return null;
  return { name, alias: stringValue(value.alias) };
}

function lastJoinSegment(joinPath: string): string {
  const segments = joinPath.split(".");
  return segments[segments.length - 1] || joinPath;
}

function yamlFragment(kind: ModelKind, definition: Record<string, unknown>): string {
  return dump(
    { [kind === "cube" ? "cubes" : "views"]: [definition] },
    { noRefs: true, lineWidth: 110, sortKeys: false },
  );
}

function collectViewNames(value: unknown, knownViews: ReadonlySet<string>, output = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\b([a-z][a-z0-9_]+)\.[a-z][a-z0-9_]+\b/gu)) {
      if (knownViews.has(match[1])) output.add(match[1]);
    }
    for (const match of value.matchAll(/\b([a-z][a-z0-9_]+_analytics)\b/gu)) {
      if (knownViews.has(match[1])) output.add(match[1]);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectViewNames(item, knownViews, output);
    return output;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      collectViewNames(key, knownViews, output);
      collectViewNames(item, knownViews, output);
    }
  }
  return output;
}

function keywordApps(value: string): AppId[] {
  const lower = value.toLowerCase();
  const apps = APP_DEFINITIONS.flatMap(({ id }) => {
    if (id === "lightspeed-r") {
      return /\blightspeed\b/u.test(lower) && !/lightspeed[-_ ]x|x-series/u.test(lower) ? [id] : [];
    }
    if (id === "lightspeed-x") return /lightspeed[-_ ]x|x-series/u.test(lower) ? [id] : [];
    return lower.includes(id) ? [id] : [];
  });
  return [...new Set(apps)];
}

function buildCatalogue() {
  const generatedAgentConfig = ALBERT_V3_AGENT_CONFIG as unknown as {
    config: Record<string, unknown>;
    alwaysRules: readonly Readonly<{ name: string; body: string }>[];
    agentRequestedRules: readonly Readonly<{ name: string; description: string; body: string }>[];
    certifiedQueries: readonly Readonly<{ name: string; userRequest: string; notes: string; query: unknown }>[];
    skills: readonly Readonly<{ name: string; title: string; description: string; body: string }>[];
  };
  const accessibleViews = recordArray(generatedAgentConfig.config.accessible_views);
  const accessByView = new Map(accessibleViews.flatMap((item) => {
    const name = stringValue(item.name);
    return name ? [[name, item] as const] : [];
  }));
  const entries = parseEntries();
  const cubeDefinitions = new Map(
    entries
      .filter((entry) => entry.kind === "cube")
      .flatMap((entry) => {
        const name = stringValue(entry.definition.name);
        return name ? [[name, entry.definition] as const] : [];
      }),
  );
  const cubeMembers = new Map<string, ReturnType<typeof memberSection>[number]>();
  for (const [cubeName, definition] of cubeDefinitions) {
    for (const section of ["dimensions", "measures", "segments"] as const) {
      for (const member of memberSection(definition, section)) {
        cubeMembers.set(`${cubeName}.${member.name}`, member);
      }
    }
  }

  const entities = entries.map((entry) => {
    const definition = entry.definition;
    const name = stringValue(definition.name) ?? "unnamed";
    const access = accessByView.get(name) ?? null;
    const configuredConnector = access ? stringValue(access.connector) : null;
    const appId = configuredConnector && CONNECTOR_TO_APP[configuredConnector]
      ? CONNECTOR_TO_APP[configuredConnector]
      : appForFile(entry.sourceFile);
    const meta = isRecord(definition.meta) ? definition.meta : {};
    const joins = entry.kind === "cube"
      ? recordArray(definition.joins).map((join) => ({
          name: stringValue(join.name) ?? "unnamed",
          relationship: stringValue(join.relationship),
          sql: stringValue(join.sql),
          properties: join,
        }))
      : [];
    const sources = entry.kind === "view"
      ? recordArray(definition.cubes).map((source) => ({
          joinPath: stringValue(source.join_path) ?? "unknown",
          prefix: source.prefix === true,
          includeCount: Array.isArray(source.includes) ? source.includes.length : 0,
          properties: source,
        }))
      : [];
    const members = entry.kind === "cube"
      ? (["dimensions", "measures", "segments"] as const)
          .flatMap((section) => memberSection(definition, section))
      : recordArray(definition.cubes).flatMap((source) => {
          const joinPath = stringValue(source.join_path) ?? "unknown";
          const sourceCube = lastJoinSegment(joinPath);
          const prefix = source.prefix === true;
          return (Array.isArray(source.includes) ? source.includes : []).flatMap((rawInclude) => {
            const include = includedMember(rawInclude);
            if (!include) return [];
            const resolved = cubeMembers.get(`${sourceCube}.${include.name}`) ?? null;
            const alias = include.alias ?? (prefix ? `${sourceCube}_${include.name}` : include.name);
            const exposure = isRecord(rawInclude) ? rawInclude : { name: rawInclude };
            return [{
              id: `${name}.${alias}`,
              name: alias,
              title: resolved?.title ?? include.name,
              kind: resolved?.kind ?? "exposed",
              type: resolved?.type ?? null,
              description: resolved?.description ?? null,
              aiContext: resolved?.aiContext ?? null,
              sql: resolved?.sql ?? null,
              format: resolved?.format ?? null,
              public: resolved?.public ?? null,
              primaryKey: resolved?.primaryKey ?? false,
              sourceCube,
              sourcePath: joinPath,
              sourceMember: include.name,
              alias,
              resolved: resolved !== null,
              properties: {
                ...(resolved?.properties ?? {}),
                exposure: { join_path: joinPath, prefix, ...exposure, alias },
              },
            }];
          });
        });
    const folders = recordArray(definition.folders).map((folder) => ({
      name: stringValue(folder.name) ?? "Unnamed folder",
      includes: stringArray(folder.includes),
      properties: folder,
    }));
    const counts = {
      dimensions: members.filter(({ kind }) => kind === "dimension").length,
      measures: members.filter(({ kind }) => kind === "measure").length,
      segments: members.filter(({ kind }) => kind === "segment").length,
      exposed: entry.kind === "view" ? members.length : 0,
      joins: joins.length,
      sources: sources.length,
      folders: folders.length,
    };
    const title = stringValue(definition.title) ?? name;
    const description = stringValue(definition.description);
    const aiContext = stringValue(meta.ai_context);
    const searchText = [
      name,
      title,
      description,
      aiContext,
      entry.sourceFile,
      ...members.flatMap((member) => [member.name, member.title, member.description, member.sourceCube]),
    ].filter(Boolean).join(" ").toLowerCase();
    return {
      id: `${entry.kind}:${name}`,
      kind: entry.kind,
      appId,
      name,
      title,
      description,
      aiContext,
      public: typeof definition.public === "boolean" ? definition.public : null,
      sql: stringValue(definition.sql),
      sourceFile: entry.sourceFile,
      meta,
      access: access ? {
        connector: configuredConnector,
        guidance: stringValue(access.guidance),
        purpose: stringValue(access.purpose),
        routingTerms: stringArray(access.routing_terms),
        keyMetrics: stringArray(access.key_metrics),
      } : null,
      counts,
      members,
      joins,
      sources,
      folders,
      definitionYaml: yamlFragment(entry.kind, definition),
      searchText,
    };
  }).sort((left, right) => (
    (APP_ORDER.get(left.appId) ?? Number.MAX_SAFE_INTEGER)
      - (APP_ORDER.get(right.appId) ?? Number.MAX_SAFE_INTEGER)
    || (left.kind === right.kind ? 0 : left.kind === "view" ? -1 : 1)
    || left.name.localeCompare(right.name)
  ));

  const entityAppByName = new Map(entities.map((entity) => [entity.name, entity.appId]));
  const knownViews = new Set(entities.filter(({ kind }) => kind === "view").map(({ name }) => name));
  const appsForKnowledge = (value: unknown): AppId[] => {
    const viewApps = [...collectViewNames(value, knownViews)]
      .flatMap((view) => entityAppByName.get(view) ?? []);
    if (viewApps.length) return [...new Set(viewApps)];
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return keywordApps(text);
  };
  const knowledge = {
    runtime: {
      version: generatedAgentConfig.config.version ?? null,
      lanes: isRecord(generatedAgentConfig.config.lanes) ? generatedAgentConfig.config.lanes : {},
      defaults: isRecord(generatedAgentConfig.config.defaults) ? generatedAgentConfig.config.defaults : {},
      accessibleViewCount: accessibleViews.length,
    },
    rules: [
      ...generatedAgentConfig.alwaysRules.map((rule) => ({
        ...rule,
        kind: "always" as const,
        description: null,
        appIds: APP_DEFINITIONS.map(({ id }) => id),
      })),
      ...generatedAgentConfig.agentRequestedRules.map((rule) => ({
        ...rule,
        kind: "agent_requested" as const,
        appIds: appsForKnowledge(`${rule.name}\n${rule.description}\n${rule.body}`),
      })),
    ],
    certifiedQueries: generatedAgentConfig.certifiedQueries.map((query) => {
      const viewNames = [...collectViewNames(query.query, knownViews)];
      const appIds = appsForKnowledge(query.query);
      return { ...query, viewNames, appIds };
    }),
    skills: generatedAgentConfig.skills.map((skill) => ({
      ...skill,
      appIds: appsForKnowledge(`${skill.name}\n${skill.title}\n${skill.description}\n${skill.body}`),
    })),
  };

  const summary = {
    apps: APP_DEFINITIONS.length,
    files: MODEL_SOURCES.length,
    cubes: entities.filter(({ kind }) => kind === "cube").length,
    views: entities.filter(({ kind }) => kind === "view").length,
    dimensions: entities.filter(({ kind }) => kind === "cube")
      .reduce((total, entity) => total + entity.counts.dimensions, 0),
    measures: entities.filter(({ kind }) => kind === "cube")
      .reduce((total, entity) => total + entity.counts.measures, 0),
    segments: entities.filter(({ kind }) => kind === "cube")
      .reduce((total, entity) => total + entity.counts.segments, 0),
    viewExposures: entities.filter(({ kind }) => kind === "view")
      .reduce((total, entity) => total + entity.counts.exposed, 0),
    joins: entities.reduce((total, entity) => total + entity.counts.joins, 0),
    rules: knowledge.rules.length,
    certifiedQueries: knowledge.certifiedQueries.length,
    skills: knowledge.skills.length,
  };

  const apps = APP_DEFINITIONS.map((app) => {
    const appEntities = entities.filter(({ appId }) => appId === app.id);
    return {
      ...app,
      cubeCount: appEntities.filter(({ kind }) => kind === "cube").length,
      viewCount: appEntities.filter(({ kind }) => kind === "view").length,
      memberCount: appEntities.reduce((total, entity) => total + entity.members.length, 0),
      fileCount: new Set(appEntities.map(({ sourceFile }) => sourceFile)).size,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    sourceOfTruth: "cube-playground/model + cube-playground/agents",
    summary,
    apps,
    entities,
    files: MODEL_SOURCES.map(({ path, kind, raw }) => ({ path, kind, raw })),
    knowledge,
  };
}

let catalogueCache: ReturnType<typeof buildCatalogue> | null = null;

export async function GET() {
  try {
    if (!(await isInternalOperator())) {
      return Response.json({ error: "Internal operator access is required." }, { status: 403 });
    }
    catalogueCache ??= buildCatalogue();
    return Response.json({ catalogue: catalogueCache }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof Error
      ? error.message
      : "The semantic layer catalogue could not be built.";
    return Response.json({ error: message }, { status });
  }
}
