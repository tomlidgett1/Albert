import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import yaml from "js-yaml";
import { catalogueFromMeta, validateCubeQuery } from "../../packages/albert-v3/src/cube/client.js";
import { hydrateViewSchemas } from "../../packages/albert-v3/src/cube/catalogue.js";

const root = path.resolve(import.meta.dirname, "../..");
const cubePath = path.join(root, "cube-playground/model/cubes/xero_reports.yml");
const viewPath = path.join(root, "cube-playground/model/views/xero_profit_and_loss_analytics.yml");
const legacyCubePath = path.join(root, "cube-playground/model/cubes/xero_accounting.yml");
const migrationPath = path.join(root, "infra/migrations/analytical/0173_m5_xero_authoritative_profit_and_loss.sql");
const configPath = path.join(root, "cube-playground/agents/config.yml");
const rulesPath = path.join(root, "cube-playground/agents/rules/xero-accounting-semantics.md");

type Named = Readonly<{ name: string; [key: string]: unknown }>;
type Model = Readonly<{ cubes?: readonly Named[]; views?: readonly Named[] }>;

const cubeModel = yaml.load(fs.readFileSync(cubePath, "utf8")) as Model;
const viewModel = yaml.load(fs.readFileSync(viewPath, "utf8")) as Model;
const allCubes = fs.readdirSync(path.join(root, "cube-playground/model/cubes"))
  .filter((name) => name.endsWith(".yml"))
  .flatMap((name) => ((yaml.load(fs.readFileSync(path.join(root, "cube-playground/model/cubes", name), "utf8")) as Model).cubes ?? []));
const allViews = fs.readdirSync(path.join(root, "cube-playground/model/views"))
  .filter((name) => name.endsWith(".yml"))
  .flatMap((name) => ((yaml.load(fs.readFileSync(path.join(root, "cube-playground/model/views", name), "utf8")) as Model).views ?? []));
const migration = fs.readFileSync(migrationPath, "utf8");
const legacyCube = fs.readFileSync(legacyCubePath, "utf8");
const rules = fs.readFileSync(rulesPath, "utf8");

function named(values: readonly Named[] | undefined, name: string): Named {
  const value = values?.find((candidate) => candidate.name === name);
  assert.ok(value, `missing ${name}`);
  return value;
}

function members(container: Named, kind: "dimensions" | "measures" | "segments"): Map<string, Named> {
  return new Map(((container[kind] as readonly Named[] | undefined) ?? []).map((value) => [value.name, value]));
}

type AccountLine = Readonly<{
  accountType: string;
  amount: number;
  reportingCode?: string;
  systemAccount?: string;
}>;

function summarise(lines: readonly AccountLine[]) {
  const amount = (...types: string[]) => lines
    .filter((line) => types.includes(line.accountType))
    .reduce((total, line) => total + line.amount, 0);
  const salesRevenue = amount("REVENUE", "SALES");
  const otherIncome = amount("OTHERINCOME");
  const costOfSales = amount("DIRECTCOSTS");
  const operatingExpenses = amount("EXPENSE", "OVERHEADS", "DEPRECIATN");
  const wageExpenses = lines
    .filter((line) => ["EXP.WAG", "EXP.EMP.WAG", "EXP.COS.WAG"].includes(line.reportingCode ?? ""))
    .reduce((total, line) => total + line.amount, 0);
  return {
    salesRevenue,
    totalIncome: salesRevenue + otherIncome,
    costOfSales,
    operatingExpenses,
    totalExpenses: costOfSales + operatingExpenses,
    grossProfit: salesRevenue - costOfSales,
    netProfit: salesRevenue + otherIncome - costOfSales - operatingExpenses,
    wageExpenses,
  };
}

test("authoritative Xero P&L cubes expose safe period and leaf-account grains", () => {
  const periods = named(cubeModel.cubes, "xero_profit_and_loss_periods");
  const accountLines = named(cubeModel.cubes, "xero_profit_and_loss_account_lines");
  assert.equal(periods.public, false);
  assert.equal(accountLines.public, false);
  assert.match(String(periods.sql), /xo_profit_and_loss_periods[\s\S]*basis = 'ACCRUAL'/u);
  assert.match(String(accountLines.sql), /xo_profit_and_loss_lines[\s\S]*is_account_line/u);

  const periodMeasures = members(periods, "measures");
  for (const name of [
    "sales_revenue", "other_income", "total_income", "cost_of_sales",
    "gross_profit", "operating_expenses", "total_expenses", "wage_expenses",
    "direct_wage_expenses", "operating_wage_expenses", "employer_super_expenses",
    "net_profit", "gross_margin_pct", "net_profit_margin_pct",
  ]) assert.ok(periodMeasures.has(name), `missing period measure ${name}`);
  assert.match(String(periodMeasures.get("net_profit")?.description), /including wages/u);
  assert.match(String(periodMeasures.get("net_profit_margin_pct")?.sql), /net_profit[\s\S]*sales_revenue/u);
  assert.match(String(periodMeasures.get("gross_margin_pct")?.sql), /gross_profit[\s\S]*sales_revenue/u);

  const accountMeasures = members(accountLines, "measures");
  assert.ok(accountMeasures.has("statement_amount"));
  for (const [name, measure] of [...periodMeasures, ...accountMeasures]) {
    assert.ok(String(measure.description ?? "").trim().length >= 20, `${name} needs a substantive definition`);
  }
  assert.match(String(accountLines.description), /leaf account rows only/iu);
  assert.match(String((accountLines.meta as Record<string, unknown>).ai_context), /do not calculate Net Profit/iu);
});

test("public Xero P&L views expose only governed headline and account-breakdown contracts", () => {
  const headline = named(viewModel.views, "xero_profit_and_loss_analytics");
  const accounts = named(viewModel.views, "xero_profit_and_loss_account_analytics");
  assert.match(String((headline.meta as Record<string, unknown>).ai_context), /ALREADY deducts wages/iu);
  assert.match(String((accounts.meta as Record<string, unknown>).ai_context), /ACCOUNT BREAKDOWN only/iu);

  const config = yaml.load(fs.readFileSync(configPath, "utf8")) as {
    accessible_views: readonly { name: string; connector: string; guidance: string }[];
  };
  for (const name of [headline.name, accounts.name]) {
    const configured = config.accessible_views.find((view) => view.name === name);
    assert.ok(configured, `${name} is not accessible to V3`);
    assert.equal(configured.connector, "xero");
    assert.match(configured.guidance, /authoritative|Xero P&L/iu);
  }

  for (const semanticView of [headline, accounts]) {
    for (const binding of (semanticView.cubes as readonly Record<string, unknown>[] | undefined) ?? []) {
      const cubeName = String(binding.join_path).split(".").at(-1)!;
      const sourceCube = named(allCubes, cubeName);
      const available = new Set([
        ...members(sourceCube, "dimensions").keys(),
        ...members(sourceCube, "measures").keys(),
        ...members(sourceCube, "segments").keys(),
      ]);
      for (const include of (binding.includes as readonly (string | Record<string, unknown>)[] | undefined) ?? []) {
        const source = typeof include === "string" ? include : String(include.name);
        assert.ok(available.has(source), `${semanticView.name} exposes missing ${cubeName}.${source}`);
      }
    }
  }
});

test("migration keeps the newest report snapshot, separates formula rows and reconciles Xero totals", () => {
  assert.match(migration, /max\(report\._albert_synced_at\) OVER/u);
  assert.match(migration, /PARTITION BY report\.tenant_id, report\.basis,[\s\S]*report\.period_start, report\.period_end/u);
  assert.match(migration, /report\._albert_synced_at = report\.snapshot_synced_at/u);
  assert.match(migration, /report\.account_id IS NOT NULL AS is_account_line/u);
  assert.match(migration, /'NET_PROFIT'/u);
  assert.match(migration, /'GROSS_PROFIT'/u);
  assert.match(migration, /account\.account_type IN \('REVENUE', 'SALES'\)/u);
  assert.match(migration, /account\.account_type = 'DIRECTCOSTS'/u);
  assert.match(migration, /account\.account_type IN \('EXPENSE', 'OVERHEADS', 'DEPRECIATN'\)/u);
  assert.match(migration, /'EXP\.WAG', 'EXP\.EMP\.WAG', 'EXP\.COS\.WAG'/u);
  assert.match(migration, /net_profit_reconciliation_variance/u);
  assert.match(migration, /gross_profit_reconciliation_variance/u);
  assert.match(migration, /abs\(net_profit_reconciliation_variance\) > 0\.01/u);
  assert.match(migration, /GRANT SELECT ON source_xero_official\.xo_profit_and_loss_periods TO semantic_ro/u);
});

test("wages reduce Net Profit exactly once and Wages Payable never enters P&L", () => {
  const operatingWages = summarise([
    { accountType: "REVENUE", amount: 1_000 },
    { accountType: "DIRECTCOSTS", amount: 300 },
    { accountType: "EXPENSE", amount: 200, reportingCode: "EXP.EMP.WAG" },
    { accountType: "OVERHEADS", amount: 100 },
    { accountType: "DEPRECIATN", amount: 50 },
    { accountType: "CURRLIAB", amount: -200, systemAccount: "WAGEPAYABLES" },
  ]);
  assert.deepEqual(operatingWages, {
    salesRevenue: 1_000,
    totalIncome: 1_000,
    costOfSales: 300,
    operatingExpenses: 350,
    totalExpenses: 650,
    grossProfit: 700,
    netProfit: 350,
    wageExpenses: 200,
  });

  const directWages = summarise([
    { accountType: "REVENUE", amount: 1_000 },
    { accountType: "DIRECTCOSTS", amount: 300 },
    { accountType: "DIRECTCOSTS", amount: 200, reportingCode: "EXP.COS.WAG" },
    { accountType: "OVERHEADS", amount: 100 },
    { accountType: "DEPRECIATN", amount: 50 },
    { accountType: "CURRLIAB", amount: -200, systemAccount: "WAGEPAYABLES" },
  ]);
  assert.equal(directWages.netProfit, 350, "direct and operating wages both reduce Net Profit");
  assert.equal(directWages.grossProfit, 500, "direct wages additionally reduce Gross Profit");
  assert.equal(directWages.wageExpenses, 200);
});

test("expense credits and sales reversals retain Xero report signs", () => {
  const baseline = summarise([
    { accountType: "REVENUE", amount: 1_000 },
    { accountType: "EXPENSE", amount: 300 },
  ]);
  const withExpenseCredit = summarise([
    { accountType: "REVENUE", amount: 1_000 },
    { accountType: "EXPENSE", amount: 300 },
    { accountType: "EXPENSE", amount: -50 },
  ]);
  const withSalesReturn = summarise([
    { accountType: "REVENUE", amount: 1_000 },
    { accountType: "REVENUE", amount: -75 },
    { accountType: "EXPENSE", amount: 300 },
  ]);
  assert.equal(withExpenseCredit.netProfit, baseline.netProfit + 50);
  assert.equal(withSalesReturn.netProfit, baseline.netProfit - 75);
});

test("invoice and bank lines normalize Xero Inclusive/Exclusive tax exactly once", () => {
  const normalized = (lineAmount: number, taxAmount: number, basis: "Inclusive" | "Exclusive" | "NoTax") => ({
    excludingTax: basis === "Inclusive" ? lineAmount - taxAmount : lineAmount,
    includingTax: basis === "Inclusive" ? lineAmount : lineAmount + taxAmount,
  });
  assert.deepEqual(normalized(110, 10, "Inclusive"), { excludingTax: 100, includingTax: 110 });
  assert.deepEqual(normalized(100, 10, "Exclusive"), { excludingTax: 100, includingTax: 110 });
  assert.deepEqual(normalized(100, 0, "NoTax"), { excludingTax: 100, includingTax: 100 });

  for (const cubeName of ["xero_invoice_line_items", "xero_bank_transaction_line_items"]) {
    const semanticCube = named(allCubes, cubeName);
    const sql = String(semanticCube.sql);
    assert.match(sql, /line_amount_types = 'Inclusive'[\s\S]*line\.line_amount - COALESCE\(line\.tax_amount, 0\)/u);
    assert.match(sql, /AS line_amount_ex_tax/u);
    assert.match(sql, /AS line_amount_including_tax/u);
    const cubeMeasures = members(semanticCube, "measures");
    assert.equal(cubeMeasures.get("total_line_amount")?.sql, "line_amount_ex_tax");
    assert.equal(cubeMeasures.get("total_line_amount_including_tax")?.sql, "line_amount_including_tax");
  }

  const finance = named(allViews, "xero_finance_analytics");
  const exposed = new Set((finance.cubes as readonly Record<string, unknown>[]).flatMap((binding) =>
    ((binding.includes as readonly (string | Record<string, unknown>)[] | undefined) ?? []).map((include) =>
      typeof include === "string" ? include : String(include.alias ?? include.name))));
  for (const member of [
    "line_currency", "line_tax_basis", "total_line_amount_including_tax",
    "bank_line_currency", "bank_line_tax_basis", "bank_line_total_including_tax",
  ]) assert.ok(exposed.has(member), `finance view lacks ${member}`);
});

test("legacy document P&L remains replayable but cannot masquerade as Net Profit", () => {
  assert.match(legacyCube, /Document-coded profit activity \(Xero, incomplete\)/u);
  assert.match(legacyCube, /Incomplete document profit impact \(deprecated\)/u);
  assert.match(legacyCube, /NOT Net Profit/u);
  assert.match(rules, /Never calculate Net Profit by\s+summing account rows/iu);
  assert.match(rules, /WAGEPAYABLES[\s\S]{0,80}liability/iu);
  assert.match(rules, /Do not label[\s\S]{0,80}EBITDA/iu);

  const finance = named(allViews, "xero_finance_analytics");
  const legacyBinding = (finance.cubes as readonly Record<string, unknown>[])
    .find((binding) => binding.join_path === "xero_pnl_lines");
  assert.ok(legacyBinding);
  for (const include of legacyBinding.includes as readonly Record<string, unknown>[]) {
    assert.equal((include.meta as Record<string, unknown> | undefined)?.ai_hidden, true,
      `legacy ${String(include.alias ?? include.name)} must be hidden from AI`);
  }
});

test("AI-hidden legacy members remain query-valid for replay but never reach model schemas", () => {
  const catalogue = catalogueFromMeta({
    cubes: [{
      name: "xero_finance_analytics",
      title: "Finance analytics (Xero)",
      measures: [
        { name: "xero_finance_analytics.pnl_net_profit", title: "Deprecated", shortTitle: "Deprecated", type: "number", meta: { aiHidden: true } },
        { name: "xero_finance_analytics.invoice_count", title: "Invoices", shortTitle: "Invoices", type: "number" },
      ],
      dimensions: [],
      segments: [],
    }],
  });
  const hidden = catalogue.views[0]!.members.find((member) => member.name.endsWith("pnl_net_profit"));
  assert.equal(hidden?.aiHidden, true);
  const validated = validateCubeQuery({ measures: ["xero_finance_analytics.pnl_net_profit"] }, catalogue);
  assert.equal("error" in validated, false, "saved legacy query must remain replayable");
  const hydrated = hydrateViewSchemas(catalogue, ["xero_finance_analytics"], [{
    name: "xero_finance_analytics",
    connector: "xero",
    guidance: "Operational Xero finance only.",
  }]);
  assert.deepEqual(hydrated.views[0]?.members.map((member) => member.name), ["xero_finance_analytics.invoice_count"]);
});

test("Xero P&L certified queries are single-view and reference governed surfaces", () => {
  const queryDir = path.join(root, "cube-playground/agents/certified_queries");
  const files = fs.readdirSync(queryDir)
    .filter((name) => name.startsWith("xero-") && name.endsWith(".md"));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const body = fs.readFileSync(path.join(queryDir, file), "utf8");
    const match = body.match(/```json\n([\s\S]*?)```/u);
    assert.ok(match, `${file} lacks JSON`);
    const query = JSON.parse(match[1]);
    const references = JSON.stringify(query).match(/xero_profit_and_loss(?:_account)?_analytics\.[a-z0-9_]+/gu) ?? [];
    assert.ok(references.length > 0, `${file} lacks governed Xero P&L members`);
    assert.equal(new Set(references.map((reference) => reference.split(".")[0])).size, 1, `${file} mixes P&L grains`);
  }
});
