import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const cubeFiles = [
  "cube-playground/model/cubes/stripe_payments.yml",
  "cube-playground/model/cubes/stripe_billing.yml",
  "cube-playground/model/cubes/stripe_payouts.yml",
  "cube-playground/model/cubes/stripe_customers.yml",
  "cube-playground/model/cubes/stripe_source_explorer.yml",
].map((path) => readFileSync(path, "utf8"));
const viewFiles = readdirSync("cube-playground/model/views")
  .filter((name) => name.startsWith("stripe_"))
  .map((name) => readFileSync(`cube-playground/model/views/${name}`, "utf8"));
const agentConfig = readFileSync("cube-playground/agents/config.yml", "utf8");
const generatedAgentConfig = readFileSync(
  "packages/albert-v3/src/agent-config/generated-agent-config.ts",
  "utf8",
);

test("Stripe cubes read official Fivetran views and never the Stripe Admin API", () => {
  const cubes = cubeFiles.join("\n");
  assert.match(cubes, /source_stripe\.st_charge/u);
  assert.match(cubes, /source_stripe\.st_subscription/u);
  assert.match(cubes, /source_stripe\.st_invoice/u);
  assert.match(cubes, /source_stripe\.st_balance_transaction/u);
  assert.match(cubes, /source_stripe\.st_source_catalog/u);
  assert.match(cubes, /source_stripe\.stripe_major_units/u);
  assert.doesNotMatch(cubes, /api\.stripe\.com/u);
  assert.doesNotMatch(cubes, /_fivetran_synced/u);
  for (const cube of [
    "stripe_charges", "stripe_payment_intents", "stripe_refunds", "stripe_disputes",
    "stripe_invoices", "stripe_subscriptions", "stripe_customers", "stripe_payouts",
    "stripe_balance_transactions", "stripe_products", "stripe_prices",
  ]) {
    assert.match(cubes, new RegExp(`name: ${cube}`));
  }
});

test("Stripe cube fields exist on the official Fivetran contract views", () => {
  const contract = readFileSync(
    "infra/migrations/analytical/0177_m2_stripe_source_views_over_fivetran.sql",
    "utf8",
  );
  const columnsByView = new Map<string, Set<string>>();
  for (const match of contract.matchAll(/\('st_([a-z_]+)',\s*\d+,\s*'([a-z_]+)'/gu)) {
    const view = `st_${match[1]}`;
    const columns = columnsByView.get(view) ?? new Set<string>(["tenant_id", "row_key"]);
    columns.add(match[2]!);
    columnsByView.set(view, columns);
  }
  columnsByView.set("st_source_catalog", new Set(["tenant_id", "row_key", "table_name", "official_view", "landed"]));

  const missing: string[] = [];
  for (const file of cubeFiles) {
    for (const cube of file.split(/\n  - name: /u).slice(1)) {
      const source = /SELECT \* FROM source_stripe\.(st_[a-z_]+)/u.exec(cube);
      if (!source) continue;
      const view = source[1]!;
      const allowed = columnsByView.get(view);
      assert.ok(allowed, `no official contract for ${view}`);
      for (const field of cube.matchAll(/\bsql:\s+(?:upper\()?([a-z_]+)\)?/gu)) {
        const name = field[1]!;
        if (!allowed.has(name)) missing.push(`${view}.${name}`);
      }
      for (const field of cube.matchAll(/\bsql:\s+"upper\(([a-z_]+)\)"/gu)) {
        const name = field[1]!;
        if (!allowed.has(name)) missing.push(`${view}.${name}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("Stripe public views and agent config cover the merchant Fivetran grains", () => {
  const views = viewFiles.join("\n");
  for (const name of [
    "stripe_payments_analytics",
    "stripe_refunds_analytics",
    "stripe_disputes_analytics",
    "stripe_billing_analytics",
    "stripe_subscriptions_analytics",
    "stripe_customer_analytics",
    "stripe_catalogue_analytics",
    "stripe_payouts_analytics",
    "stripe_balance_analytics",
    "stripe_checkout_analytics",
    "stripe_connect_analytics",
    "stripe_source_explorer",
  ]) {
    assert.match(views, new RegExp(`name: ${name}`));
    assert.match(agentConfig, new RegExp(`name: ${name}\\n\\s+connector: stripe`));
    assert.match(generatedAgentConfig, new RegExp(`"name": "${name}"`));
  }
});
