import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { compileSemanticQuery } from "../../packages/compiler/src/index.js";
import { loadRegistryFile } from "../../packages/semantic-registry/src/index.js";
import { toConnectionsWorkspace } from "../../services/control-plane/src/connections-workspace.js";

const controlMigration = readFileSync(
  resolve("infra/migrations/control-plane/0013_m7_identity_decision_projection.sql"),
  "utf8",
);
const analyticalMigration = readFileSync(
  resolve("infra/migrations/analytical/0071_m7_reversible_identity_graph.sql"),
  "utf8",
);
const identityEvidenceMigration = readFileSync(
  resolve("infra/migrations/analytical/0072_m4_identity_evidence_associations.sql"),
  "utf8",
);
const boundedIdentityMigration = readFileSync(
  resolve("infra/migrations/analytical/0104_m4_bounded_identity_candidate_generation.sql"),
  "utf8",
);
const neutralScopeMigration = readFileSync(
  resolve("infra/migrations/analytical/0076_m4_source_neutral_identity_scopes.sql"),
  "utf8",
);
const canonicalPipeline = readFileSync(
  resolve("services/sync-workers/src/canonical-pipeline.ts"),
  "utf8",
);
const transformService = readFileSync(
  resolve("services/transform-worker/src/service.ts"),
  "utf8",
);
const deletionMigration = readFileSync(
  resolve("infra/migrations/analytical/0060_m8_deletion_procedures.sql"),
  "utf8",
);
const semanticDatabase = readFileSync(
  resolve("services/semantic-query/src/database.ts"),
  "utf8",
);

test("identity decisions cross the database boundary through a leased immutable outbox", () => {
  assert.match(controlMigration, /identity_decision_projection_outbox/);
  assert.match(controlMigration, /FOR UPDATE SKIP LOCKED/);
  assert.match(controlMigration, /lease_token=control_plane\.generate_ulid\(\)/);
  assert.match(controlMigration, /identity\.match_projection_applied/);
  assert.match(controlMigration, /projection_status','pending'/);
  assert.match(controlMigration, /projection_status','failed'/);
  assert.match(controlMigration, /earlier\.decision_version<item\.decision_version[\s\S]*earlier\.status IN \('queued','running','retry_wait'\)/);
  assert.doesNotMatch(controlMigration, /task\.status\s*=\s*'proposed'/);
  assert.match(transformService, /identityProjectionIntervalMs\?\?1_000/);
  assert.match(canonicalPipeline, /claim_identity_decision_projection/);
  assert.match(canonicalPipeline, /apply_identity_decision/);
  assert.match(canonicalPipeline, /complete_identity_decision_projection/);
});

test("accepted identity edges are reversible, graph-versioned, cache-invalidating and deletion-safe", () => {
  assert.match(analyticalMigration, /CREATE TABLE IF NOT EXISTS core\.entity_identity_edge/);
  assert.match(analyticalMigration, /CREATE TABLE IF NOT EXISTS core\.entity_resolution/);
  assert.match(analyticalMigration, /identity_decision_history_immutable/);
  assert.match(analyticalMigration, /decision_version>=p_decision_version/);
  assert.match(analyticalMigration, /CREATE TABLE IF NOT EXISTS semantic_internal\.identity_graph_state/);
  assert.match(analyticalMigration, /identity_graph_state\.version\+1/);
  assert.match(analyticalMigration, /identityGraphVersion/);
  assert.match(analyticalMigration, /hashtextextended\('deletion:'\|\|p_tenant_id,0\)/);
  assert.doesNotMatch(analyticalMigration, /UPDATE core\.entity_source_link[\s\S]*superseded_by=new_link_id/);
  assert.match(analyticalMigration, /DELETE FROM semantic_internal\.result_cache WHERE tenant_id=p_tenant_id/);
  assert.match(analyticalMigration, /WITH RECURSIVE[\s\S]*min\(origin_id\) AS resolved_entity_id/);
  assert.match(deletionMigration, /DELETE FROM core\.entity_resolution WHERE tenant_id=p_tenant_id/);
  assert.match(deletionMigration, /DELETE FROM semantic_internal\.identity_decision_history WHERE tenant_id=p_tenant_id/);
  assert.match(deletionMigration, /DELETE FROM semantic_internal\.identity_graph_state WHERE tenant_id=p_tenant_id/);
  assert.match(canonicalPipeline, /Facts always retain the source-owned canonical foreign key/);
  assert.match(canonicalPipeline, /graph resolution is the[\s\S]*only mechanism allowed to merge entities/);
  assert.match(canonicalPipeline, /canonical_entity_id=excluded\.canonical_entity_id/);
  assert.match(semanticDatabase, /REPEATABLE READ READ ONLY/);
  assert.match(semanticDatabase, /pg_advisory_xact_lock_shared/);
  assert.match(semanticDatabase, /IDENTITY_GRAPH_CHANGED/);
});

test("identity lookup evidence enriches stable native subjects without connector-pair conditionals", () => {
  assert.match(identityEvidenceMigration, /ADD COLUMN IF NOT EXISTS evidence_refs jsonb/);
  assert.match(identityEvidenceMigration, /subject\.linkable/);
  assert.match(identityEvidenceMigration, /jsonb_array_elements\(subject\.evidence_refs\)/);
  assert.match(identityEvidenceMigration, /canonical_record_state AS left_native/);
  assert.match(identityEvidenceMigration, /left_link\.canonical_entity_id=left_native\.canonical_id/);
  assert.match(identityEvidenceMigration, /right_link\.canonical_entity_id=right_native\.canonical_id/);
  assert.match(identityEvidenceMigration, /left_native\.canonical_id<>right_native\.canonical_id/);
  assert.doesNotMatch(identityEvidenceMigration, /(?:deputy|lightspeed)/i);
  assert.doesNotMatch(identityEvidenceMigration, /JOIN core\.entity_resolution/i);
  assert.match(canonicalPipeline, /evidence_refs=excluded\.evidence_refs/);
});

test("identity candidate generation is bounded before and during cross-source matching", () => {
  assert.match(
    boundedIdentityMigration,
    /HAVING min\(connection_id\)<>max\(connection_id\)[\s\S]*RETURN 0/u,
  );
  assert.match(boundedIdentityMigration, /effective_keys AS MATERIALIZED/u);
  assert.match(
    boundedIdentityMigration,
    /right_key\.key=left_key\.key[\s\S]*right_key\.value=left_key\.value/u,
  );
  assert.match(boundedIdentityMigration, /external_pairs AS MATERIALIZED/u);
  assert.match(boundedIdentityMigration, /deterministic_pairs AS MATERIALIZED/u);
  assert.match(boundedIdentityMigration, /composite_pairs AS MATERIALIZED/u);
  assert.match(boundedIdentityMigration, /canonical_record_state_source_identity_idx/u);
  assert.doesNotMatch(
    boundedIdentityMigration,
    /JOIN subjects AS right_row[\s\S]{0,600}\)\s+OR\s+EXISTS/u,
  );
  assert.match(
    canonicalPipeline,
    /if\(identityEvidenceChanged\)\{[\s\S]*generateIdentitySuggestions/u,
  );
});

test("worker name-plus-location suggestions use source-neutral location evidence", () => {
  assert.match(neutralScopeMigration, /ADD COLUMN IF NOT EXISTS corroborating_scope_ref jsonb/u);
  assert.match(neutralScopeMigration, /location_resolution\.entity_type='location'/u);
  assert.match(neutralScopeMigration, /location_resolution\.resolved_entity_id/u);
  assert.match(neutralScopeMigration, /location_name_address/u);
  assert.match(neutralScopeMigration, /corroborating_scope_digest=calculated\.neutral_scope_digest/u);
  assert.match(canonicalPipeline, /refresh_identity_scope_digests\(\$1\)[\s\S]*generate_identity_review_candidates\(\$1\)/u);
  assert.match(canonicalPipeline, /apply_identity_decision\([\s\S]*refresh_identity_scope_digests\(\$1\)[\s\S]*generate_identity_review_candidates\(\$1\)[\s\S]*publishPendingControlProjections/u);
  assert.match(
    canonicalPipeline,
    /corroborating_scope_digest:corroboratingScopeRef[\s\S]{0,80}\?null[\s\S]{0,120}:command\.corroboratingScope/u,
  );
});

test("semantic SQL resolves governed identity keys before aggregation and dimension joins", () => {
  const registry = loadRegistryFile(resolve("packages/semantic-registry/registry/registry.yaml"));
  const compiled = compileSemanticQuery({
    kind: "single",
    topic: "customers_retention",
    metrics: ["customers.active_customers"],
    dimensions: ["customer"],
    filters: [],
    time: { field: "last_order_at", range: { type: "last_n_days", days: 90 }, compare: "none" },
    sort: [],
    limit: 100,
    parameters: {},
  }, registry, {
    tenantId: "01J00000000000000000000001",
    role: "owner",
    capabilities: new Set(["commerce.orders.customer"]),
    now: "2026-08-03T00:00:00.000Z",
    timezone: "Australia/Melbourne",
    tenantParameters: { active_customer_days: 90 },
  });

  assert.match(compiled.sql, /LEFT JOIN "core"\."entity_resolution" identity\d+/);
  assert.match(compiled.sql, /COUNT\(DISTINCT COALESCE\(identity\d+\."resolved_entity_id", f\."customer_account_id"\)\)/);
  assert.match(compiled.sql, /d0\."id" = COALESCE\(identity\d+\."resolved_entity_id", f\."customer_account_id"\)/);
});

test("workspace cards use real connection providers and preserve decision/projection state", () => {
  const workspace = toConnectionsWorkspace({
    tenant_id: "01J00000000000000000000001",
    tenant_name: "Albert Bikes",
    connections: [
      {
        connection_id: "01J00000000000000000000011",
        connector_key: "lightspeed-r",
        display_name: "Albert Bikes",
        status: "connected",
        auth_health: "healthy",
        readiness: [],
      },
      {
        connection_id: "01J00000000000000000000012",
        connector_key: "deputy",
        display_name: "Albert Bikes Deputy",
        status: "connected",
        auth_health: "healthy",
        readiness: [],
      },
    ],
    identity_review_tasks: [{
      task_id: "01J00000000000000000000021",
      entity_type: "worker",
      status: "accepted",
      confidence_band: "high",
      candidate_links: [
        { connection_id: "01J00000000000000000000011", source_record_id: "employee-7", label: "Jessica Chen" },
        { connection_id: "01J00000000000000000000012", source_record_id: "employee-9", label: "Jess C" },
      ],
      evidence: { summary: "Exact work email." },
      resolution: { projection_status: "pending" },
    }],
    blocking_answers: {},
    oauth_sessions: [],
  }, "Australia/Melbourne");

  assert.equal(workspace.identityMatches[0]?.first.provider, "lightspeed");
  assert.equal(workspace.identityMatches[0]?.second.provider, "deputy");
  assert.equal(workspace.identityMatches[0]?.decision, "accepted");
  assert.equal(workspace.identityMatches[0]?.projectionStatus, "pending");
});
