import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = await Promise.all([
  readFile("infra/migrations/control-plane/0043_m5_durable_semantic_promotion_relay.sql", "utf8"),
  readFile("infra/migrations/analytical/0084_m5_durable_semantic_promotion_relay.sql", "utf8"),
  readFile("services/semantic-query/src/promotion-relay.ts", "utf8"),
  readFile("services/semantic-query/src/service.ts", "utf8"),
  readFile("services/semantic-query/src/postgres-adapters.ts", "utf8"),
  readFile("services/semantic-query/src/composition.ts", "utf8"),
  readFile("services/control-plane/src/operator-repository.ts", "utf8"),
  readFile("app/dash/components/AdminWorkspace.tsx", "utf8"),
  readFile("infra/migrations/analytical/0060_m8_deletion_procedures.sql", "utf8"),
  readFile(".github/workflows/ci.yml", "utf8"),
  readFile("docs/adr/0025-durable-cross-database-semantic-promotion-relay.md", "utf8"),
]);

const [controlMigration,analyticalMigration,relay,semanticService,auditAdapter,
  composition,operatorRepository,operatorUi,deletionMigration,ci,adr] = files;

test("control acceptance is exact-login, lifecycle-fenced and occurrence-idempotent", () => {
  assert.match(controlMigration, /PRIMARY KEY\(tenant_id,candidate_id\)/u);
  assert.match(controlMigration, /candidate_digest IS DISTINCT FROM p_candidate_digest/u);
  assert.match(controlMigration, /require_exact_runtime_login\(\s*'albert_semantic_control_runtime','albert_semantic_control'/u);
  assert.match(controlMigration, /FOR SHARE OF tenant,connection/u);
  assert.match(controlMigration, /request\.status IN \('queued','running','retry_wait','verifying','failed'\)/u);
  assert.match(controlMigration, /pg_advisory_xact_lock\(\s*hashtextextended\('semantic-promotion:'/u);
  assert.match(controlMigration, /IF FOUND THEN[\s\S]*replayed:=true[\s\S]*RETURN/u);
  assert.match(controlMigration, /INSERT INTO control_plane\.semantic_promotion_deliveries[\s\S]*IF existing_item\.semantic_inbox_item_id<>p_candidate_id THEN[\s\S]*occurrence_count=inbox\.occurrence_count\+1/u);
  assert.match(controlMigration, /semantic\.promotion_candidate_accepted/u);
  assert.doesNotMatch(controlMigration, /auth\.(?:uid|jwt|users)/u);
});

test("question content is minimized and never crosses the promotion boundary", () => {
  assert.match(controlMigration, /Question content withheld; digest/u);
  assert.match(controlMigration, /'question_content_persisted',false/u);
  assert.doesNotMatch(relay, /sampleQuestion|rawQuestion|questionText/u);
  assert.match(relay, /questionDigest/u);
  assert.match(analyticalMigration, /p_question_digest !~ '\^\[a-f0-9\]\{64\}\$'/u);
});

test("analytical outbox access is capability-scoped, leased and restart recoverable", () => {
  assert.match(analyticalMigration, /require_semantic_metadata_claims/u);
  assert.match(analyticalMigration, /verify_token\([\s\S]*'semantic_metadata'/u);
  assert.match(analyticalMigration, /claim_due_promotion_candidates/u);
  assert.match(analyticalMigration, /FOR UPDATE SKIP LOCKED/u);
  assert.match(analyticalMigration, /lease_expires_at=clock_timestamp\(\)\+make_interval/u);
  assert.match(analyticalMigration, /available_at=clock_timestamp\(\)\+make_interval/u);
  assert.match(analyticalMigration, /REVOKE ALL ON TABLE semantic_internal\.promotion_candidate_outbox[\s\S]*semantic_meta_rw/u);
  assert.match(analyticalMigration, /GRANT EXECUTE ON FUNCTION[\s\S]*enqueue_promotion_candidate[\s\S]*claim_due_promotion_candidates[\s\S]*TO semantic_meta_rw/u);
  assert.match(analyticalMigration, /pg_advisory_xact_lock_shared\(hashtextextended\('deletion:'/u);
});

test("background recovery enumerates only active control tenants and receives per-tenant signed capabilities", () => {
  assert.match(controlMigration, /semantic_promotion_relay_tenants/u);
  assert.match(controlMigration, /tenant\.status='active'/u);
  assert.match(controlMigration, /FOR UPDATE OF relay SKIP LOCKED/u);
  assert.match(controlMigration, /'analytical:semantic-metadata','semantic_metadata'/u);
  assert.match(controlMigration, /'kind','semantic_promotion_recovery'/u);
  assert.match(relay, /claim_semantic_promotion_relay_tenants/u);
  assert.match(relay, /lease\.analyticalCapability/u);
  assert.doesNotMatch(relay, /albert\.tenant_id/u);
  assert.doesNotMatch(relay, /BYPASSRLS|DISABLE ROW LEVEL SECURITY/iu);
});

test("source exploration returns filing evidence only after durable relay acknowledgement", () => {
  assert.match(semanticService, /const queryId = ulid\(\);[\s\S]*await this\.dependencies\.audit\.promoteSourceField\(\{\s*queryId/u);
  assert.match(auditAdapter, /return this\.promotionRelay\.fileAndDeliver\(candidate\)/u);
  assert.match(relay, /await this\.deliverClaim\([\s\S]*return candidateId/u);
  assert.match(relay, /complete_promotion_candidate/u);
  assert.match(relay, /accept_semantic_promotion_candidate/u);
  assert.match(composition, /promotionRelay\.start\(\)/u);
  assert.match(composition, /promotionRelayReady/u);
  assert.match(composition, /await promotionRelay\.stop\(\)/u);
});

test("operator console exposes bounded relay metadata and deletion covers both ledgers", () => {
  assert.match(controlMigration, /public\.albert_operator_semantic_inbox/u);
  assert.match(controlMigration, /operator\.semantic_inbox_read/u);
  assert.match(controlMigration, /p_limit NOT BETWEEN 1 AND 500/u);
  assert.match(operatorRepository, /"semantic_inbox"/u);
  assert.match(operatorUi, /Source-field promotion inbox/u);
  assert.match(operatorUi, /promotion_relay/u);
  assert.match(deletionMigration, /DELETE FROM semantic_internal\.promotion_candidate_outbox WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id/u);
  assert.match(analyticalMigration, /verify_connection_before_promotion_relay/u);
  assert.match(analyticalMigration, /promotion_remaining/u);
  assert.match(controlMigration, /REFERENCES control_plane\.semantic_inbox[\s\S]*ON DELETE CASCADE/u);
});

test("SQL adversarial coverage is release-gating and the ADR records the crash boundary", () => {
  assert.match(ci, /control-plane-semantic-promotion-relay-seed\.sql/u);
  assert.match(ci, /-U albert_semantic_control_runtime[\s\S]*control-plane-semantic-promotion-relay\.sql/u);
  assert.match(ci, /control-plane-semantic-promotion-relay-verify\.sql/u);
  assert.match(adr, /business\s+effect is exactly once through idempotent acceptance/u);
  assert.match(adr, /never receives a global analytical RLS bypass/u);
});
