import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";

// Cube joins a cube once per query. product_sales_analytics reached employees
// through the line (sale_lines.employees) and through the sale header
// (sale_lines.sales.employees), so its "seller of record" returned the line's
// staff member: sale 61992 showed two sellers of record against one header.
// The header seller has its own cube, joined on the projected sale_employee_id.

const root = path.resolve(import.meta.dirname, "../..");
type Cube = { name: string; sql?: string; joins?: { name: string; sql: string }[]; dimensions?: { name: string; sql?: string }[] };
type View = { name: string; cubes: { join_path: string; includes: (string | { name: string; alias?: string })[] }[] };
const cubes = (file: string) => (load(readFileSync(path.join(root, "cube-playground/model/cubes", file), "utf8")) as { cubes: Cube[] }).cubes;

test("the seller of record comes from its own cube, joined on the header employee", () => {
  const saleEmployees = cubes("organisation.yml").find((cube) => cube.name === "sale_employees");
  assert.ok(saleEmployees, "a sale_employees cube exists");
  assert.match(saleEmployees.sql ?? "", /ls_employees/u);
  assert.ok(saleEmployees.dimensions?.some((dimension) => dimension.name === "full_name"));

  const saleLines = cubes("sale_lines.yml").find((cube) => cube.name === "sale_lines")!;
  const join = saleLines.joins?.find((candidate) => candidate.name === "sale_employees");
  assert.match(join?.sql ?? "", /\{CUBE\}\.sale_employee_id = \{sale_employees\}\.employee_id/u);

  const view = (load(readFileSync(path.join(root, "cube-playground/model/views/product_sales_analytics.yml"), "utf8")) as { views: View[] }).views[0]!;
  const seller = view.cubes.find((cube) => cube.includes.some((member) => typeof member === "object" && member.alias === "sale_employees_full_name"));
  assert.equal(seller?.join_path, "sale_lines.sale_employees");
  assert.equal(view.cubes.some((cube) => cube.join_path === "sale_lines.sales.employees"), false, "employees is reached once, through the line");
});
