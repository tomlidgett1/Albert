import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

// Postgres sorts NULL first in a descending order, and Cube renders every
// order as `ORDER BY <column> DESC`. "When did we last sell a Trace" led with
// lines on quotes and open work orders (no completion date), and an all-time
// "top items by revenue" with items that never sold. The Cube dialect now
// puts empty values last on descending sorts.

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const { extendDialect, nullsLastOrderBy } = require(path.join(root, "cube-playground/nulls-last-dialect.js")) as {
  extendDialect: (base: unknown) => new () => { orderHashToString: (hash: unknown) => string | null; sqlTemplates: () => { expressions: { order_by: string } } };
  nullsLastOrderBy: (template: unknown) => unknown;
};
/** Cube 1.7.16's order_by template, which the Tesseract planner (Cube's default) renders ORDER BY with. */
const ORDER_BY = "{% if index %} {{ index }} {% else %} {{ expr }} {% endif %} {% if asc %}ASC{% else %}DESC{% endif %}{% if nulls_first %} NULLS FIRST{% endif %}";

/** Cube 1.7.16's BaseQuery.orderHashToString and sqlTemplates, as the dialect finds them. */
class CubeBaseQuery {
  sqlTemplates() {
    return { expressions: { order_by: '{% if index %} {{ index }} {% else %} {{ expr }} {% endif %} {% if asc %}ASC{% else %}DESC{% endif %}{% if nulls_first %} NULLS FIRST{% endif %}' } };
  }

  getFieldIndex(id: string): number | null {
    return id === "unknown" ? null : 2;
  }

  orderHashToString(hash: { id?: string; desc?: boolean } | null): string | null {
    if (!hash || !hash.id) {
      return null;
    }
    const fieldIndex = this.getFieldIndex(hash.id);
    if (fieldIndex === null) {
      return null;
    }
    const direction = hash.desc ? 'DESC' : 'ASC';
    return `${fieldIndex} ${direction}`;
  }
}

test("descending sorts put empty values last; ascending and unknown members are unchanged", () => {
  const Dialect = extendDialect(CubeBaseQuery);
  const query = new Dialect();
  assert.equal(query.orderHashToString({ id: "product_sales_analytics.completed_at", desc: true }), "2 DESC NULLS LAST");
  assert.equal(query.orderHashToString({ id: "product_sales_analytics.completed_at", desc: false }), "2 ASC");
  assert.equal(query.orderHashToString({ id: "unknown", desc: true }), null);
  assert.equal(query.orderHashToString(null), null);
  assert.ok(query instanceof CubeBaseQuery, "everything else is Cube's own Postgres dialect");
  // Rendered by Cube's real planners in the 1.7.16 image: "ORDER BY 2 DESC NULLS LAST", "ORDER BY 2 ASC".
  assert.equal(query.sqlTemplates().expressions.order_by, ORDER_BY.replace("{% if nulls_first %} NULLS FIRST{% endif %}", "{% if nulls_first %} NULLS FIRST{% elif not asc %} NULLS LAST{% endif %}"));
  assert.equal(nullsLastOrderBy("{{ expr }} DESC"), "{{ expr }} DESC", "an unrecognised template is left alone");
});

test("the dialect refuses to load when Cube's sort rendering has moved", () => {
  assert.throws(() => extendDialect(class {}), /no orderHashToString/u);
  assert.throws(() => extendDialect(class { orderHashToString() { return "1 DESC"; } }), /no longer renders the sort direction/u);
  class MovedTemplate extends CubeBaseQuery {
    sqlTemplates() {
      return { expressions: { order_by: "{{ expr }} {% if asc %}ASC{% else %}DESC{% endif %}" } };
    }
  }
  class TemplateElsewhere {
    orderHashToString(hash: { desc?: boolean }) { const direction = hash.desc ? 'DESC' : 'ASC'; return direction; }
  }
  assert.throws(() => extendDialect(MovedTemplate), /order_by SQL template no longer ends with the nulls_first clause/u);
  assert.throws(() => extendDialect(TemplateElsewhere), /order_by SQL template no longer ends with the nulls_first clause/u);
  // Cube's PostgresQuery overrides sqlTemplates for other templates and inherits BaseQuery's order_by.
  class PostgresLike extends CubeBaseQuery {
    sqlTemplates() {
      const templates = super.sqlTemplates() as ReturnType<CubeBaseQuery["sqlTemplates"]> & { functions?: Record<string, string> };
      templates.functions = { NOW: "NOW({{ args_concat }})" };
      return templates;
    }
  }
  assert.equal(new (extendDialect(PostgresLike))().sqlTemplates().expressions.order_by.endsWith("{% elif not asc %} NULLS LAST{% endif %}"), true);
});

test("cube.js compiles every Postgres query through the dialect, and the image carries it", async () => {
  const [config, dockerfile] = await Promise.all([
    readFile(path.join(root, "cube-playground/cube.js"), "utf8"),
    readFile(path.join(root, "cube-playground/Dockerfile"), "utf8"),
  ]);
  assert.match(config, /const NullsLastPostgresQuery = extendDialect\(PostgresQuery\);/u);
  assert.match(config, /dialectFactory: \(\{ dbType \}\) => \(dbType && dbType !== 'postgres' \? undefined : NullsLastPostgresQuery\)/u);
  assert.match(dockerfile, /COPY cube-playground\/nulls-last-dialect\.js \/cube\/conf\/nulls-last-dialect\.js/u);
});
