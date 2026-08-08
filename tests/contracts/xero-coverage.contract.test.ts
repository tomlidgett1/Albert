import assert from "node:assert/strict";
import test from "node:test";
import {
  XERO_COVERAGE,
  XERO_FIELD_CENSUS,
  computeXeroCoverage,
} from "../../connectors/xero/coverage.js";
import { XERO_ACCOUNTING_OPENAPI_REVISION } from "../../connectors/xero/documented-fields.js";
import { XERO_FIELD_COVERAGE } from "../../connectors/xero/field-coverage.js";
import { XERO_SPEC_TABLES, xeroSourceField } from "../../connectors/xero/scan-plan.js";
import { xeroManifest } from "../../connectors/xero/manifest.js";
import tablesJson from "../../connectors/xero/tables.json" with { type: "json" };

const artifact = tablesJson as unknown as Readonly<{
  exclusions: readonly Readonly<{ api: string; pattern: string; reason: string }>[];
  unaccounted: readonly Readonly<{ field: string; reason: string }>[];
}>;

test("the field census is pinned to the same immutable OpenAPI revision as the pack", () => {
  assert.match(XERO_FIELD_CENSUS.revision, /^[a-f0-9]{40}$/u);
  assert.equal(XERO_FIELD_CENSUS.revision, XERO_ACCOUNTING_OPENAPI_REVISION);
  assert.match(xeroManifest.apiVersion, new RegExp(XERO_ACCOUNTING_OPENAPI_REVISION));
  // The census is the denominator of the proof; it must describe the whole
  // granted surface, not just the accounting API.
  assert.deepEqual(
    XERO_FIELD_CENSUS.specs.map((spec) => spec.api).sort(),
    ["accounting", "assets", "files", "identity", "payroll_au", "payroll_nz", "payroll_uk", "projects"],
  );
  assert.equal(XERO_FIELD_CENSUS.totals.fields, XERO_FIELD_CENSUS.fields.length);
  assert.equal(new Set(XERO_FIELD_CENSUS.fields).size, XERO_FIELD_CENSUS.fields.length);
});

test("every documented Xero field is accounted for — no silent ingestion gaps", () => {
  assert.deepEqual(
    XERO_COVERAGE.missing,
    [],
    "a missing field is a field the connector would never ingest while claiming complete coverage",
  );
  assert.equal(XERO_COVERAGE.pct, "100.0");
  assert.equal(
    XERO_COVERAGE.mapped + XERO_COVERAGE.excluded + XERO_COVERAGE.unaccounted,
    XERO_COVERAGE.fields,
  );
  // The overwhelming majority must be genuinely mapped into tables: the two
  // escape hatches exist to be explicit, not to absorb the surface.
  assert.ok(
    XERO_COVERAGE.mapped / XERO_COVERAGE.fields > 0.9,
    `only ${XERO_COVERAGE.mapped}/${XERO_COVERAGE.fields} fields are mapped into tables`,
  );
});

test("no column invents provenance the official specification does not document", () => {
  assert.deepEqual(XERO_COVERAGE.unresolvable, []);
});

test("both escape hatches carry a reason that survives review", () => {
  for (const exclusion of artifact.exclusions) {
    assert.ok(XERO_FIELD_CENSUS.schemaGraph[exclusion.api], `${exclusion.api} is not a census spec`);
    assert.match(exclusion.pattern, /^[A-Za-z][A-Za-z0-9]*\.(\*|[A-Za-z][A-Za-z0-9]*)$/u);
    assert.ok(exclusion.reason.length > 40, `${exclusion.api}:${exclusion.pattern} has a thin reason`);
  }
  const censusFields = new Set(XERO_FIELD_CENSUS.fields);
  for (const entry of artifact.unaccounted) {
    assert.ok(censusFields.has(entry.field), `${entry.field} is not in the census`);
    assert.ok(entry.reason.length > 40, `${entry.field} has a thin reason`);
  }
});

test("the coverage proof is recomputed from the artifact, never cached", () => {
  const recomputed = computeXeroCoverage();
  assert.deepEqual(recomputed.missing, []);
  assert.equal(recomputed.tables, XERO_SPEC_TABLES.length);
  assert.equal(recomputed.columns, XERO_SPEC_TABLES.reduce((total, table) => total + table.columns.length, 0));

  // A deliberately broken artifact must fail: the proof has to be capable of
  // returning a non-empty missing list, or it proves nothing.
  const gutted = {
    generatedFrom: "test",
    tables: [],
    exclusions: [],
    unaccounted: [],
  };
  const broken = computeXeroCoverage(XERO_FIELD_CENSUS, gutted);
  assert.equal(broken.missing.length, XERO_FIELD_CENSUS.fields.length);
  assert.equal(broken.pct, "0.0");
});

test("every census-mapped field reaches a real staging column", () => {
  // Coverage is only meaningful if the mapped fields actually stage: the
  // dictionary, the field coverage and the staging column names are one chain.
  const staged = new Set(XERO_FIELD_COVERAGE.map((entry) => `${entry.stream}:${entry.field}`));
  for (const table of XERO_SPEC_TABLES) {
    for (const column of table.columns) {
      assert.ok(
        staged.has(`${table.id}:${xeroSourceField(column)}`),
        `${table.id}.${column.name} is in the dictionary but stages nothing`,
      );
    }
  }
  assert.equal(XERO_FIELD_COVERAGE.length, XERO_COVERAGE.columns);
});
