import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../infra/migrations/control-plane/0017_m2_operator_pipeline_console.sql",
  import.meta.url,
);
const repositoryUrl = new URL(
  "../../services/control-plane/src/operator-repository.ts",
  import.meta.url,
);
const routeUrl = new URL(
  "../../app/api/admin/pipeline/[tenantId]/route.ts",
  import.meta.url,
);
const workspaceUrl = new URL(
  "../../app/dash/components/AdminWorkspace.tsx",
  import.meta.url,
);
const stylesUrl = new URL("../../app/dash/dash.module.css", import.meta.url);
const ciUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);

test("operator projections are audited, allowlisted and control-plane only", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.albert_operator_fleet\(\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.albert_operator_pipeline\(p_tenant_id text\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.albert_operator_pipeline_stage\([\s\S]*p_stage text/);
  assert.match(migration, /control_plane\.is_internal_operator\(\)/);
  assert.match(migration, /'operator\.fleet_read'/);
  assert.match(migration, /'operator\.pipeline_read'/);
  assert.match(migration, /'operator\.pipeline_drilldown'[\s\S]*jsonb_build_object\('stage', p_stage\)/);
  assert.match(migration, /p_stage <> ALL \(ARRAY\[[\s\S]*'connections'[\s\S]*'budgets'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.albert_operator_pipeline_stage\(text, text\) FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.albert_operator_pipeline_stage\(text, text\) TO authenticated/);

  assert.doesNotMatch(
    migration,
    /\b(?:from|join|update|into|delete\s+from)\s+(?:core|mart|quality|source_lightspeed|source_xero|source_deputy)\.[a-z_]/i,
  );
  assert.doesNotMatch(migration, /token\.secret_reference|token_ref\.secret_reference/i);
  assert.doesNotMatch(migration, /to_jsonb\(connection\)|to_jsonb\(token/i);
  assert.doesNotMatch(migration, /'safe_headers'|'payload'\s*,\s*job\.payload/i);
  assert.match(migration, /pipeline_stats/);
  assert.match(migration, /ORDER BY extracted_at DESC LIMIT 200/);
  assert.match(migration, /ORDER BY started_at DESC LIMIT 300/);
});

test("operator API validates every payload and audits each stage drill-down", async () => {
  const [repository, route, ci] = await Promise.all([
    readFile(repositoryUrl, "utf8"),
    readFile(routeUrl, "utf8"),
    readFile(ciUrl, "utf8"),
  ]);

  assert.match(repository, /const fleetSchema = z\.object/);
  assert.match(repository, /const pipelineSchema = z\.object/);
  assert.match(repository, /const pipelineDetailSchema = z\.object/);
  assert.match(repository, /export const OPERATOR_PIPELINE_STAGES/);
  assert.match(repository, /supabase\.rpc\("albert_operator_pipeline_stage"/);
  assert.doesNotMatch(repository, /ANALYTICAL_DATABASE_URL|\bpg\b|semantic_ro|diagnostic_ro/);
  assert.match(route, /isOperatorPipelineStage\(stage\)/);
  assert.match(route, /loadOperatorPipelineStage\(tenantId, stage\)/);
  assert.match(route, /Cache-Control": "private, no-store"/);
  assert.match(ci, /tests\/sql\/control-plane-operator-console\.sql/);
});

test("fleet and tenant views cover the complete Section 19 operating path", async () => {
  const workspace = await readFile(workspaceUrl, "utf8");

  for (const label of [
    "Connections", "Streams", "Raw", "Staging", "Canonical", "Marts", "Quality", "Readiness",
    "Recent runs", "Jobs & attempts", "Quarantine", "Vendor budgets",
  ]) {
    assert.match(workspace, new RegExp(label.replace(/[&]/g, "\\&")));
  }
  for (const fleetField of [
    "Authorisation", "Readiness", "Streams", "Backfill", "Webhook", "Quarantine", "Quality", "Vendor budget",
  ]) {
    assert.match(workspace, new RegExp(`>${fleetField}<`));
  }
  assert.match(workspace, /\?stage=\$\{encodeURIComponent\(stage\)\}/);
  assert.match(workspace, /aria-current=\{active \? "step"/);
  assert.match(workspace, /aria-busy=\{loadingScope === "detail"\}/);
  assert.match(workspace, /ArchitectureMap/);
  assert.match(workspace, /\/api\/admin\/architecture/);
  assert.match(workspace, /How Albert works/);
  assert.doesNotMatch(workspace, /ANALYTICAL_DATABASE_URL|diagnostic_ro|semantic_ro/);
});

test("architecture map explains the backend for non-technical operators", async () => {
  const [architectureRoute, architectureMap, workspace] = await Promise.all([
    readFile(new URL("../../app/api/admin/architecture/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/dash/components/ArchitectureMap.tsx", import.meta.url), "utf8"),
    readFile(workspaceUrl, "utf8"),
  ]);

  assert.match(architectureRoute, /isInternalOperator/);
  assert.match(architectureRoute, /parseRegistryDocument/);
  assert.match(architectureRoute, /registry\.yaml\?raw/);
  assert.match(architectureRoute, /registry-build/);
  assert.match(architectureRoute, /loadOperatorFleet/);
  assert.match(architectureRoute, /dimension_count/);
  assert.match(architectureRoute, /metrics,/);
  assert.match(architectureRoute, /Cache-Control": "private, no-store"/);
  assert.doesNotMatch(architectureRoute, /loadRegistryFile|process\.cwd\(/);
  assert.match(architectureMap, /HOW ALBERT WORKS/);
  assert.match(architectureMap, /SEMANTIC LAYER/);
  assert.match(architectureMap, /SEMANTIC DICTIONARY/);
  assert.match(architectureMap, /Browse the full catalogue/);
  assert.match(architectureMap, /PLAN PREVIEW CHAT|PlanPreviewChat/);
  assert.match(architectureMap, /HOW THE DICTIONARY FITS TOGETHER/);
  assert.match(architectureMap, /Lightspeed bike store/);
  assert.match(architectureMap, /commerce\.net_sales_ex_gst/);
  assert.match(architectureMap, /sales_performance/);
  assert.match(architectureMap, /WHERE THINGS LIVE/);
  assert.match(architectureMap, /Six steps, left to right/);
  assert.match(architectureMap, /onOpenFleet/);
  assert.match(workspace, /\{ key: "architecture" as const, label: "Architecture" \}/);
  assert.match(workspace, /\{ key: "fleet" as const, label: "Fleet" \}/);
});

test("plan preview reuses chat agent tools without executing answers", async () => {
  const [planPreview, route] = await Promise.all([
    readFile(new URL("../../services/conversation/src/plan-preview.ts", import.meta.url), "utf8"),
    readFile(new URL("../../app/api/admin/plan-preview/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(planPreview, /PLAN ONLY/);
  assert.match(planPreview, /run_semantic_query/);
  assert.match(planPreview, /run_source_query/);
  assert.match(planPreview, /search_catalogue/);
  assert.match(planPreview, /albert-admin-plan-preview/);
  assert.match(planPreview, /applyLocalCatalogue/);
  assert.match(planPreview, /catalogueIsEmpty/);
  assert.match(planPreview, /Plan preview must keep working when the semantic service is down/);
  assert.doesNotMatch(planPreview, /finalizeAnswerArtifact/);
  assert.match(route, /isInternalOperator/);
  assert.match(route, /runPlanPreviewTurn/);
  assert.match(route, /Cache-Control": "private, no-store"/);
});

test("operator UI remains dash-native across dark mode, mobile and reduced motion", async () => {
  const styles = await readFile(stylesUrl, "utf8");
  const operatorStyles = styles.slice(styles.indexOf("/* Section 19 operator console."));

  assert.match(operatorStyles, /var\(--dash-control-height\)/);
  assert.match(operatorStyles, /var\(--dash-surface\)/);
  assert.match(operatorStyles, /var\(--dash-text-heading\)/);
  assert.match(operatorStyles, /border-radius: 16px/);
  assert.match(operatorStyles, /border-radius: 999px/);
  assert.match(operatorStyles, /cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
  assert.match(operatorStyles, /@media \(max-width: 700px\)/);
  assert.match(operatorStyles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(operatorStyles, /\.opsWorkspace,[\s\S]*animation: none/);
  assert.match(operatorStyles, /\.archMap/);
  assert.match(operatorStyles, /\.archDictionary/);
  assert.match(operatorStyles, /\.opsViewTabIndicator/);
  assert.doesNotMatch(operatorStyles, /#[0-9a-f]{3,8}\b/i);
});
