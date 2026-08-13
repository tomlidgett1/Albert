import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { squareManifest } from "../../connectors/square/manifest.js";
import { SQUARE_READ_STREAMS } from "../../connectors/square/streams.js";
import { buildStagingContracts } from "../../packages/connector-sdk/src/staging.js";

test("every Square staging table preserves governed request parent context", () => {
  const contracts = buildStagingContracts([squareManifest]);
  assert.equal(contracts.length, SQUARE_READ_STREAMS.length);
  for (const contract of contracts) {
    assert.equal(contract.schema, "source_square");
    assert.deepEqual(
      contract.fields.map((field) => [field.sourceField, field.column, field.type]),
      [
        ["payload_json", "payload_json", "jsonb"],
        ["field_index", "field_index", "jsonb"],
        ["parent_context", "parent_context", "jsonb"],
      ],
      contract.stream,
    );
  }
});

test("Square applied migrations cover all stream tables and parent_context columns", () => {
  const baseline = readFileSync(
    new URL("../../infra/migrations/analytical/0141_m3_square_production_staging.sql", import.meta.url),
    "utf8",
  );
  const additive = readFileSync(
    new URL("../../infra/migrations/analytical/0146_m3_square_nested_parent_context.sql", import.meta.url),
    "utf8",
  );

  assert.equal(
    baseline.match(/^CREATE TABLE IF NOT EXISTS "source_square"\."square_[a-z0-9_]+"/gmu)?.length,
    SQUARE_READ_STREAMS.length,
  );
  for (const stream of SQUARE_READ_STREAMS) {
    assert.match(
      baseline,
      new RegExp(`CREATE TABLE IF NOT EXISTS "source_square"\\."${stream.id}"`, "u"),
      stream.id,
    );
    assert.match(additive, new RegExp(`\\('${stream.id}'\\)`, "u"), stream.id);
  }
  assert.equal(
    additive.match(/^\s*\('square_[a-z0-9_]+'\),?$/gmu)?.length,
    SQUARE_READ_STREAMS.length,
  );
  assert.match(additive, /parent_context jsonb NOT NULL DEFAULT ''\{\}''::jsonb/u);
  assert.match(additive, /jsonb_typeof\(parent_context\) = ''object''/u);
});

test("nested Square semantic joins use parent_context without mutating payload_json", () => {
  const finance = readFileSync(
    new URL("../../cube-playground/model/cubes/square_finance.yml", import.meta.url),
    "utf8",
  );
  const operations = readFileSync(
    new URL("../../cube-playground/model/cubes/square_operations.yml", import.meta.url),
    "utf8",
  );
  const runtime = readFileSync(new URL("../../connectors/square/index.ts", import.meta.url), "utf8");

  assert.match(finance, /parent_context->>'payout_id'/u);
  assert.match(operations, /parent_context->>'cash_drawer_shift_id'/u);
  assert.match(runtime, /payload_json: source,[\s\S]*field_index: buildSquareFieldIndex\(source\),[\s\S]*parent_context: Object\.freeze/u);
  assert.doesNotMatch(runtime, /payload_json:\s*\{[\s\S]{0,180}pathParameters/u);
});
