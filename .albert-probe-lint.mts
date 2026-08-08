import { lintSqlFirstStatement } from "./packages/semantic-registry/src/linter.js";
import { loadRegistryFile } from "./packages/semantic-registry/src/load.js";
import { buildSqlFirstCanaries } from "./services/semantic-query/src/sql-first.js";
const registry = loadRegistryFile("packages/semantic-registry/registry/registry.yaml");
const sql = "SELECT c.category_name, SUM(f.signed_net_amount_ex_tax) AS net_sales FROM mart.commerce_sales_event f JOIN core.product_category c ON c.category_id = f.rollup_category_id WHERE f.business_date >= '2026-05-09' GROUP BY c.category_name";
try {
  const lint = lintSqlFirstStatement(sql, [{ metricId: "commerce.net_sales_ex_gst", column: "net_sales" }], registry);
  console.log("lint ok, violations:", lint.violations.length, "facts:", JSON.stringify(lint.factScopes?.map((f: any) => f.factId) ?? []));
  const canaries = buildSqlFirstCanaries(lint.factScopes);
  console.log("canaries:", JSON.stringify(canaries).slice(0, 500));
} catch (e) {
  console.log("THROW:", (e as Error).stack?.split("\n").slice(0, 5).join(" | "));
}
