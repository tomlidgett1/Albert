import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../infra/migrations/analytical/0144_m8_lightspeed_x_deletion_closure.sql",
  import.meta.url,
);

test("Lightspeed X deletion extends private delegates without replacing signed wrappers", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  for (const signature of [
    "purge_connection_pre_capability\\(text,text\\)",
    "purge_tenant_pre_capability\\(text\\)",
    "verify_connection_pre_capability\\(text,text\\)",
    "verify_tenant_pre_capability\\(text\\)",
  ]) {
    assert.match(sql, new RegExp(`ALTER FUNCTION deletion_internal\\.${signature}`));
  }

  assert.doesNotMatch(
    sql,
    /ALTER FUNCTION deletion_internal\.(?:purge|verify)_(?:connection|tenant)\((?:text,)?text\)\s+RENAME/u,
    "The signed one-use wrapper names must remain unchanged.",
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION[\s\S]*deletion_internal\.purge_connection\(text,text\)[\s\S]*deletion_internal\.verify_tenant\(text\)[\s\S]*TO deletion_rw/u,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION[\s\S]*purge_connection_pre_capability\(text,text\)[\s\S]*verify_tenant_pre_capability\(text\)[\s\S]*TO albert_migration_owner/u,
  );
});

test("Lightspeed X connection and tenant purges are catalog-driven and fail closed", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(
    sql,
    /information_schema\.tables[\s\S]*information_schema\.columns[\s\S]*table_schema='source_lightspeed_x'[\s\S]*table_type='BASE TABLE'/u,
  );
  assert.match(
    sql,
    /DELETE FROM source_lightspeed_x\.%I[\s\S]*tenant_id=\$1 AND connection_id=\$2/u,
  );
  assert.match(
    sql,
    /DELETE FROM source_lightspeed_x\.%I WHERE tenant_id=\$1/u,
  );
  assert.match(
    sql,
    /IF remaining>0 THEN[\s\S]*Lightspeed X-Series tenant purge left % staging rows/u,
  );
  assert.match(
    sql,
    /IF remaining>0 THEN[\s\S]*Lightspeed X-Series connection purge left % staging rows/u,
  );
  assert.match(sql, /NOT table_row\.has_tenant_id OR NOT table_row\.has_connection_id/u);
  assert.match(sql, /EXCEPTION WHEN foreign_key_violation THEN[\s\S]*NULL/u);
  assert.match(
    sql,
    /purge_connection_before_lightspeed_x_staging\([\s\S]*p_tenant_id,p_connection_id/u,
  );
  assert.match(
    sql,
    /purge_tenant_before_lightspeed_x_staging\([\s\S]*p_tenant_id/u,
  );
});

test("Lightspeed X verification preserves the exact measured residual contract", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const residualKeys = [
    "stagingRows",
    "canonicalRows",
    "bridgeRows",
    "linkRows",
    "embeddingRows",
    "cacheRows",
    "otherAnalyticalRows",
  ];

  assert.equal(
    (sql.match(/SELECT count\(\*\) FROM jsonb_object_keys\(base->'residuals'\)\)<>7/gu) ?? []).length,
    2,
  );
  for (const key of residualKeys) {
    assert.match(sql, new RegExp(`'${key}'`));
  }
  assert.match(
    sql,
    /SELECT count\(\*\) FROM source_lightspeed_x\.%I AS residual[\s\S]*residual\.tenant_id=\$1 AND residual\.connection_id=\$2/u,
  );
  assert.match(
    sql,
    /SELECT count\(\*\) FROM source_lightspeed_x\.%I AS residual[\s\S]*residual\.tenant_id=\$1/u,
  );
  assert.equal((sql.match(/base,\s*'\{residuals,stagingRows\}'/gu) ?? []).length, 2);
  assert.equal((sql.match(/'\{remainingRows\}'/gu) ?? []).length, 2);
  assert.equal((sql.match(/'\{verified\}'/gu) ?? []).length, 2);
  assert.doesNotMatch(sql, /jsonb_build_object\([\s\S]*'residuals'/u);
});
