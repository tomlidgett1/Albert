import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import yaml from "js-yaml";

import { MOMENCE_READ_STREAMS } from "../../connectors/momence/streams";

const root = path.resolve(import.meta.dirname, "../..");
const cubeDir = path.join(root, "cube-playground/model/cubes");
const viewDir = path.join(root, "cube-playground/model/views");
const agentsDir = path.join(root, "cube-playground/agents");

type Named = Readonly<{ name: string; [key: string]: unknown }>;
type ModelDocument = Readonly<{ cubes?: readonly Named[]; views?: readonly Named[] }>;

function documents(dir: string): readonly ModelDocument[] {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => yaml.load(fs.readFileSync(path.join(dir, name), "utf8")) as ModelDocument);
}

const allCubes = documents(cubeDir).flatMap((document) => document.cubes ?? []);
const allViews = documents(viewDir).flatMap((document) => document.views ?? []);
const momenceCubes = allCubes.filter((cube) => cube.name.startsWith("momence_"));
const momenceViews = allViews.filter((view) => view.name.startsWith("momence_"));
const cubeByName = new Map(allCubes.map((cube) => [cube.name, cube]));
const viewByName = new Map(allViews.map((view) => [view.name, view]));

function members(container: Named, key: "dimensions" | "measures" | "segments"): readonly string[] {
  return ((container[key] as readonly Named[] | undefined) ?? []).map((member) => member.name);
}

function cube(name: string): Named {
  const found = cubeByName.get(name);
  assert.ok(found, `missing cube ${name}`);
  return found;
}

function view(name: string): Named {
  const found = viewByName.get(name);
  assert.ok(found, `missing view ${name}`);
  return found;
}

function exposedMembers(semanticView: Named): ReadonlySet<string> {
  const exposed = new Set<string>();
  for (const binding of (semanticView.cubes as readonly Record<string, unknown>[] | undefined) ?? []) {
    const terminal = String(binding.join_path).split(".").at(-1)!;
    const sourceCube = cube(terminal);
    const available = new Set([
      ...members(sourceCube, "dimensions"),
      ...members(sourceCube, "measures"),
      ...members(sourceCube, "segments"),
    ]);
    for (const include of (binding.includes as readonly (string | Record<string, unknown>)[] | undefined) ?? []) {
      const sourceName = typeof include === "string" ? include : String(include.name);
      const alias = typeof include === "string" ? include : String(include.alias ?? include.name);
      assert.ok(available.has(sourceName), `${semanticView.name} exposes missing ${terminal}.${sourceName}`);
      exposed.add(binding.prefix === true ? `${terminal}_${alias}` : alias);
    }
  }
  return exposed;
}

test("Momence CubeCore covers every native business domain plus the exhaustive source-field fallback", () => {
  const expectedCubes = [
    "momence_host_accounts",
    "momence_members",
    "momence_schedule_events",
    "momence_attendance_events",
    "momence_membership_plans",
    "momence_member_entitlements",
    "momence_instructors",
    "momence_locations",
    "momence_tags",
    "momence_sales",
    "momence_sale_items",
    "momence_sale_tenders",
    "momence_payment_transactions",
    "momence_payment_items",
    "momence_refunds",
    "momence_source_fields",
  ];
  const expectedViews = [
    "momence_member_analytics",
    "momence_schedule_analytics",
    "momence_attendance_analytics",
    "momence_membership_catalogue_analytics",
    "momence_member_entitlement_analytics",
    "momence_instructor_analytics",
    "momence_location_analytics",
    "momence_tag_analytics",
    "momence_sales_analytics",
    "momence_product_sales_analytics",
    "momence_sale_tender_analytics",
    "momence_payment_analytics",
    "momence_payment_method_analytics",
    "momence_refund_analytics",
    "momence_source_explorer",
  ];

  assert.deepEqual(expectedCubes.filter((name) => !cubeByName.has(name)), []);
  assert.deepEqual(expectedViews.filter((name) => !viewByName.has(name)), []);
  assert.equal(new Set(momenceCubes.map(({ name }) => name)).size, momenceCubes.length);
  assert.equal(new Set(momenceViews.map(({ name }) => name)).size, momenceViews.length);

  for (const sourceCube of momenceCubes) {
    assert.equal(sourceCube.public, false, `${sourceCube.name} must remain private behind a governed view`);
    assert.ok(String(sourceCube.description ?? "").trim().length >= 50, `${sourceCube.name} needs a business description`);
    assert.ok(
      String((sourceCube.meta as Record<string, unknown> | undefined)?.ai_context ?? "").trim().length >= 80,
      `${sourceCube.name} needs substantive AI context`,
    );
  }
  for (const semanticView of momenceViews) {
    assert.ok(String(semanticView.description ?? "").trim().length >= 50, `${semanticView.name} needs a business description`);
    assert.ok(
      String((semanticView.meta as Record<string, unknown> | undefined)?.ai_context ?? "").trim().length >= 80,
      `${semanticView.name} needs substantive AI context`,
    );
    assert.ok(exposedMembers(semanticView).size > 0, `${semanticView.name} must expose governed members`);
    assert.ok(exposedMembers(semanticView).has("tenant_id"), `${semanticView.name} must retain tenant scope`);
  }
});

test("every Momence ingestion stream is available through a native cube or exhaustive source union", () => {
  const cubeText = fs.readdirSync(cubeDir)
    .filter((name) => name.startsWith("momence_") && name.endsWith(".yml"))
    .map((name) => fs.readFileSync(path.join(cubeDir, name), "utf8"))
    .join("\n");
  const explorerMigration = fs.readFileSync(
    path.join(root, "infra/migrations/analytical/0140_m3_momence_source_explorer.sql"),
    "utf8",
  );

  assert.match(cubeText, /source_momence\.mo_source_fields/u);
  for (const stream of MOMENCE_READ_STREAMS) {
    const table = `source_momence.${stream.id}`;
    assert.ok(
      cubeText.includes(table) || explorerMigration.includes(table),
      `${stream.id} is absent from curated CubeCore and the exhaustive union`,
    );
  }
  assert.doesNotMatch(cubeText, /\bcore\.(commerce_|workforce_|finance_)/u);
  assert.doesNotMatch(cubeText, /WHERE\s+NOT\s+\w+\.tombstone\s+OR/iu);
});

test("the exhaustive Momence field explorer preserves stable and exact identity plus every typed channel", () => {
  const explorer = cube("momence_source_fields");
  assert.match(String(explorer.sql), /source_momence\.mo_source_fields/u);
  for (const dimension of [
    "parent_stream",
    "source_object_type",
    "source_record_id",
    "field_path",
    "field_pointer",
    "field_ordinal",
    "value_kind",
    "text_value",
    "numeric_value",
    "boolean_value",
    "timestamp_value",
    "raw_value",
    "potentially_sensitive",
    "value_state",
  ]) {
    assert.ok(members(explorer, "dimensions").includes(dimension), `momence_source_fields.${dimension} is missing`);
  }
  for (const measure of [
    "field_occurrences",
    "source_records",
    "numeric_value_sum",
    "numeric_value_average",
    "numeric_value_minimum",
    "numeric_value_maximum",
  ]) {
    assert.ok(members(explorer, "measures").includes(measure), `momence_source_fields.${measure} is missing`);
  }
  const context = String((view("momence_source_explorer").meta as Record<string, unknown>).ai_context);
  assert.match(context, /exact parent_stream|exact.*field_path/iu);
  assert.match(context, /PII|authorization/iu);
  assert.match(JSON.stringify(explorer.meta), /every field returned/iu);
});

test("Momence models preserve schedule, membership, money and discovery boundaries", () => {
  const operations = JSON.stringify(cube("momence_schedule_events"));
  const attendance = JSON.stringify(cube("momence_attendance_events"));
  const plans = JSON.stringify(cube("momence_membership_plans"));
  const entitlements = JSON.stringify(cube("momence_member_entitlements"));
  const sales = JSON.stringify(cube("momence_sales"));
  const payments = JSON.stringify(cube("momence_payment_transactions"));
  const refunds = JSON.stringify(cube("momence_refunds"));
  const instructors = JSON.stringify(cube("momence_instructors"));

  assert.match(operations, /booked-place|reserved-place|reservations.*not attendance/iu);
  assert.match(attendance, /No-show proxy|no_show_proxy/iu);
  assert.match(attendance, /ticketsBought/iu);
  assert.match(plans, /currency code|currency.*not/iu);
  assert.match(entitlements, /current entitlement snapshot/iu);
  assert.match(entitlements, /Frozen.*not cancelled|not.*cancellation/iu);
  assert.match(sales, /no currency|currency.*absent/iu);
  assert.match(sales, /not certified revenue|reported sale values/iu);
  assert.match(payments, /status succeeded|succeeded.*captured/iu);
  assert.match(payments, /partial.*member notes|member notes.*partial/iu);
  assert.match(refunds, /refund-event grain/iu);
  assert.match(instructors, /not proof of employee|not.*payroll/iu);
});

test("all Momence views and certified queries are production-configured and reference real members", () => {
  const config = yaml.load(fs.readFileSync(path.join(agentsDir, "config.yml"), "utf8")) as {
    accessible_views: readonly { name: string; connector: string; guidance: string }[];
  };
  const configured = new Set(
    config.accessible_views.filter(({ connector }) => connector === "momence").map(({ name }) => name),
  );
  assert.deepEqual([...configured].sort(), momenceViews.map(({ name }) => name).sort());
  for (const entry of config.accessible_views.filter(({ connector }) => connector === "momence")) {
    assert.ok(entry.guidance.trim().length >= 100, `${entry.name} needs substantive routing guidance`);
  }

  const queryFiles = fs.readdirSync(path.join(agentsDir, "certified_queries"))
    .filter((name) => name.startsWith("momence-") && name.endsWith(".md"));
  assert.ok(queryFiles.length >= 10, "Momence needs broad certified coverage");
  for (const file of queryFiles) {
    const body = fs.readFileSync(path.join(agentsDir, "certified_queries", file), "utf8");
    const match = body.match(/```json\n([\s\S]*?)```/u);
    assert.ok(match, `${file} lacks a JSON Cube query`);
    const query = JSON.parse(match[1]) as Record<string, unknown>;
    const references = JSON.stringify(query).match(/momence_[a-z0-9_]+\.[a-z0-9_]+/gu) ?? [];
    assert.ok(references.length > 0, `${file} has no Momence members`);
    const names = new Set(references.map((reference) => reference.split(".")[0]));
    assert.equal(names.size, 1, `${file} mixes native fact views`);
    const viewName = [...names][0];
    assert.ok(configured.has(viewName), `${file} uses inaccessible ${viewName}`);
    const available = exposedMembers(view(viewName));
    for (const reference of references) {
      const member = reference.slice(viewName.length + 1);
      assert.ok(available.has(member), `${file} references missing ${reference}`);
    }
  }
});

test("Momence always-on guidance governs yoga terminology, partial coverage, PII and source fallback", () => {
  const rules = fs.readFileSync(
    path.join(agentsDir, "rules/momence-yoga-studio-semantics.md"),
    "utf8",
  );
  for (const concept of [
    "yoga",
    "booked",
    "attendance",
    "no-show",
    "entitlement",
    "Frozen",
    "currency",
    "captured",
    "refund",
    "partial",
    "field_path",
    "PII",
  ]) {
    assert.match(rules, new RegExp(concept, "iu"), `Momence guidance lacks ${concept}`);
  }
});
