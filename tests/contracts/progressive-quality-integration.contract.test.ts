import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  resolveReadinessQualityStatus,
  type ReadinessQualityEvidence,
} from "../../services/sync-workers/src/canonical-pipeline.js";

const critical = evidence("cursor_completeness", "passed", true);
const retentionBlocked = evidence("retention_limit_recorded", "blocked", false);
const reconciliationMissing = evidence("webhook_gap_recovered", null, false);
const deleteFailed = evidence("delete_handling", "failed", false);

test("bounded recent readiness qualifies deferred history checks without weakening critical checks", () => {
  assert.equal(
    resolveReadinessQualityStatus(
      [critical, retentionBlocked, reconciliationMissing, deleteFailed],
      false,
    ),
    "warning",
  );
  assert.equal(
    resolveReadinessQualityStatus(
      [evidence("cursor_completeness", "blocked", true), retentionBlocked],
      false,
    ),
    "blocked",
  );
  assert.equal(
    resolveReadinessQualityStatus(
      [evidence("schema_drift", "failed", true), retentionBlocked],
      false,
    ),
    "failed",
  );
  assert.equal(resolveReadinessQualityStatus([], false), "blocked");
});

test("complete readiness remains gated by every mandatory quality check", () => {
  assert.equal(
    resolveReadinessQualityStatus([critical, retentionBlocked], true),
    "blocked",
  );
  assert.equal(
    resolveReadinessQualityStatus([critical, deleteFailed], true),
    "failed",
  );
  assert.equal(
    resolveReadinessQualityStatus([
      critical,
      evidence("retention_limit_recorded", "passed", false),
      evidence("webhook_gap_recovered", "passed", false),
      evidence("delete_handling", "passed", false),
    ], true),
    "passed",
  );
});

test("the analytical policy and control projection preserve the same two readiness tiers", async () => {
  const [migration, pipeline, progressiveControl, qualityControl] = await Promise.all([
    readFile("infra/migrations/analytical/0090_m5_progressive_quality_integration.sql", "utf8"),
    readFile("services/sync-workers/src/canonical-pipeline.ts", "utf8"),
    readFile("infra/migrations/control-plane/0045_m2_progressive_dependency_barriers.sql", "utf8"),
    readFile("infra/migrations/control-plane/0050_m2_progressive_quality_tiers.sql", "utf8"),
  ]);

  assert.match(migration, /blocks_partial_readiness boolean NOT NULL DEFAULT true/);
  assert.match(
    migration,
    /'retention_limit_recorded','webhook_gap_recovered','delete_handling'/,
  );
  assert.match(migration, /quality\.connector_stream_state state/);
  assert.doesNotMatch(
    migration,
    /FROM quality\.connector_check_observation observation/,
  );
  assert.match(
    pipeline,
    /readinessQualityStatuses\(client,job\.tenantId,job\.syncRunId\)/,
  );
  assert.match(pipeline, /partialQualityStatus:qualityStatuses\.partial/);
  assert.match(pipeline, /completeQualityStatus:qualityStatuses\.complete/);
  assert.match(
    progressiveControl,
    /state=CASE WHEN readiness\.state IN \('blocked','degraded'\)[\s\S]*ELSE 'ready_partial' END/,
  );
  assert.match(qualityControl, /p_current_partial_quality text/);
  assert.match(qualityControl, /p_current_complete_quality text/);
  assert.match(qualityControl, /complete_quality_status IN \('blocked','failed'\)/);
  assert.match(qualityControl, /complete_quality_pending/);
});

function evidence(
  checkId: string,
  status: ReadinessQualityEvidence["status"],
  blocksPartialReadiness: boolean,
): ReadinessQualityEvidence {
  return { checkId, status, blocksPartialReadiness };
}
