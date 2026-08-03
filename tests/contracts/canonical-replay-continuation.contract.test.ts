import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration=await readFile(
  new URL("../../infra/migrations/control-plane/0064_m4_bounded_canonical_replay_continuations.sql",import.meta.url),
  "utf8",
);
const queue=await readFile(
  new URL("../../services/transform-worker/src/queue.ts",import.meta.url),
  "utf8",
);
const registry=await readFile(
  new URL("../../connectors/canonical-registry.ts",import.meta.url),
  "utf8",
);
const capabilities=await readFile(
  new URL("../../infra/migrations/control-plane/0038_m0_m8_signed_analytical_capabilities.sql",import.meta.url),
  "utf8",
);
const dependencyClaim=await readFile(
  new URL("../../infra/migrations/control-plane/0045_m2_progressive_dependency_barriers.sql",import.meta.url),
  "utf8",
);

test("transform claims carry the immutable active connection generation",()=>{
  assert.match(migration,/run\.connection_generation[\s\S]*?connection\.connection_generation=run\.connection_generation/u);
  assert.match(migration,/INSERT INTO control_plane\.canonical_transform_jobs[\s\S]*?connection_generation/u);
  assert.match(migration,/claim_canonical_transform_job_v2[\s\S]*?job\.connection_generation/u);
  const claimStart=dependencyClaim.indexOf(
    "CREATE OR REPLACE FUNCTION control_plane.claim_canonical_transform_job(",
  );
  const claimEnd=dependencyClaim.indexOf("\n$$;",claimStart);
  assert.ok(claimStart>=0&&claimEnd>claimStart);
  const claimBody=dependencyClaim.slice(claimStart,claimEnd);
  assert.match(
    claimBody,
    /JOIN control_plane\.connections connection[\s\S]*?connection\.connection_generation=run\.connection_generation[\s\S]*?connection\.status IN \('connected','degraded'\)[\s\S]*?UPDATE control_plane\.canonical_transform_jobs/u,
    "stale/disconnected jobs must be excluded before the running transition",
  );
  assert.match(queue,/claim_canonical_transform_job_v2/u);
  assert.match(queue,/connectionGeneration/u);
  assert.match(
    capabilities,
    /connection\.connection_generation=job\.connection_generation[\s\S]*?connection\.status IN \('connected','degraded'\)/u,
  );
});

test("replay operations cannot substitute a stale connection generation",()=>{
  assert.match(registry,/values\[3\] === scope\.connectionGeneration/u);
  assert.match(registry,/canonical_dependency_replay_generation_stale/u);
  assert.match(registry,/audit\.connection_generation=\$4::bigint/u);
});

test("continuations are unbounded by failures but reject zero or repeated progress",()=>{
  assert.match(migration,/continuation_count=job\.continuation_count\+1/u);
  assert.match(migration,/attempt_count=greatest\(job\.attempt_count-1,0\)/u);
  assert.match(
    migration,
    /candidates'\)::integer\+[\s\S]*?\(p_progress->>'commands'\)::integer<1/u,
  );
  assert.match(
    migration,
    /continuation_result->>'progressToken'[\s\S]*?IS DISTINCT FROM p_progress->>'progressToken'/u,
  );
  assert.match(
    migration,
    /canonical_transform_continuation_progress[\s\S]*?progress\.progress_token=p_progress->>'progressToken'/u,
  );
  assert.match(migration,/continuation_command_count=job\.continuation_command_count\+/u);
  assert.match(migration,/job\.lease_token=p_lease_token[\s\S]*?job\.lease_expires_at>now\(\)/u);
});
