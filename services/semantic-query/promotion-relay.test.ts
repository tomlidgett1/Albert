import assert from "node:assert/strict";
import test from "node:test";
import type { PgClientLike, PgPoolLike, SemanticAnalyticalCapabilityIssuer } from "./src/database.js";
import { PostgresSemanticPromotionRelay } from "./src/promotion-relay.js";

const TENANT_ID = "01H00000000000000000000101";
const CONVERSATION_ID = "01H00000000000000000000102";
const TURN_ID = "01H00000000000000000000103";
const QUERY_ID = "01H00000000000000000000104";
const CONNECTION_ID = "01H00000000000000000000105";
const INBOX_ID = "01H00000000000000000000106";
const SCAN_TOKEN = "01H00000000000000000000107";
const CAPABILITY = JSON.stringify({ payload: "x".repeat(140), signature: "a".repeat(64) });

type StoredCandidate = {
  candidateId: string;
  queryId: string;
  connectionId: string;
  connectorId: string;
  sourceTable: string;
  sourceFields: string[];
  questionDigest: string;
  candidateDigest: string;
  attemptCount: number;
  delivered: boolean;
};

class RelayFixture {
  readonly candidates = new Map<string, StoredCandidate>();
  readonly deliveredCandidateIds = new Set<string>();
  readonly analyticalCapabilities: string[] = [];
  readonly controlPool: PgPoolLike = this.pool("control");
  readonly analyticalPool: PgPoolLike = this.pool("analytical");
  readonly capabilityIssuer: SemanticAnalyticalCapabilityIssuer = {
    issue: async () => CAPABILITY,
    ready: async () => true,
  };
  inboxOccurrences = 0;
  failCompleteOnce = false;
  tenantClaimed = false;
  scanCompleted = false;
  outboxFailureCount = 0;

  private pool(kind: "control" | "analytical"): PgPoolLike {
    return {
      connect: async () => ({
        query: async (sql, parameters = []) => this.query(kind, sql, parameters),
        release() {},
      } satisfies PgClientLike),
    };
  }

  private async query(
    kind: "control" | "analytical",
    sql: string,
    parameters: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Readonly<Record<string, unknown>>[] }>> {
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL ROLE)/u.test(sql)) return { rows: [] };
    if (/set_config\('albert\.tenant_capability'/u.test(sql)) {
      this.analyticalCapabilities.push(String(parameters[0]));
      return { rows: [{ set_config: parameters[0] }] };
    }
    if (/enqueue_promotion_candidate/u.test(sql)) {
      assert.equal(kind, "analytical");
      const candidateId = String(parameters[0]);
      this.candidates.set(candidateId, {
        candidateId,
        queryId: String(parameters[1]),
        connectionId: String(parameters[4]),
        connectorId: String(parameters[5]),
        sourceTable: String(parameters[6]),
        sourceFields: [...parameters[7] as string[]],
        questionDigest: String(parameters[8]),
        candidateDigest: "a".repeat(64),
        attemptCount: 0,
        delivered: false,
      });
      return { rows: [{ candidate_digest: "a".repeat(64) }] };
    }
    if (/claim_promotion_candidate\(/u.test(sql)) {
      const candidate = this.requiredCandidate(String(parameters[0]));
      candidate.attemptCount += 1;
      return { rows: [{ claim_status: candidate.delivered ? "delivered" : "claimed", ...row(candidate), control_inbox_item_id: candidate.delivered ? INBOX_ID : null }] };
    }
    if (/accept_semantic_promotion_candidate/u.test(sql)) {
      assert.equal(kind, "control");
      const candidateId = String(parameters[1]);
      if (!this.deliveredCandidateIds.has(candidateId)) {
        this.deliveredCandidateIds.add(candidateId);
        this.inboxOccurrences += 1;
      }
      return { rows: [{ semantic_inbox_item_id: INBOX_ID, occurrence_count: this.inboxOccurrences, replayed: this.inboxOccurrences > 1 }] };
    }
    if (/complete_promotion_candidate/u.test(sql)) {
      if (this.failCompleteOnce) {
        this.failCompleteOnce = false;
        throw Object.assign(new Error("simulated post-accept outage"), { code: "08006" });
      }
      this.requiredCandidate(String(parameters[0])).delivered = true;
      return { rows: [{ completed: true }] };
    }
    if (/fail_promotion_candidate/u.test(sql)) {
      this.outboxFailureCount += 1;
      return { rows: [{ fail_promotion_candidate: true }] };
    }
    if (/claim_semantic_promotion_relay_tenants/u.test(sql)) {
      if (this.tenantClaimed) return { rows: [] };
      this.tenantClaimed = true;
      return { rows: [{ tenant_id: TENANT_ID, lease_token: SCAN_TOKEN, analytical_capability: CAPABILITY }] };
    }
    if (/claim_due_promotion_candidates/u.test(sql)) {
      const candidates = [...this.candidates.values()].filter((candidate) => !candidate.delivered);
      for (const candidate of candidates) candidate.attemptCount += 1;
      return { rows: candidates.map(row) };
    }
    if (/complete_semantic_promotion_relay_tenant/u.test(sql)) {
      this.scanCompleted = true;
      return { rows: [{ complete_semantic_promotion_relay_tenant: true }] };
    }
    if (/fail_semantic_promotion_relay_tenant/u.test(sql)) {
      return { rows: [{ fail_semantic_promotion_relay_tenant: true }] };
    }
    if (/assert_(semantic_promotion_relay|promotion_relay)_ready/u.test(sql)) {
      return { rows: [{ ready: true }] };
    }
    throw new Error(`Unexpected ${kind} SQL: ${sql}`);
  }

  private requiredCandidate(candidateId: string): StoredCandidate {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new Error("fixture candidate missing");
    return candidate;
  }
}

function row(candidate: StoredCandidate): Readonly<Record<string, unknown>> {
  return {
    candidate_id: candidate.candidateId,
    query_id: candidate.queryId,
    connection_id: candidate.connectionId,
    connector_id: candidate.connectorId,
    source_table: candidate.sourceTable,
    source_fields: candidate.sourceFields,
    question_digest: candidate.questionDigest,
    requested_metric_concept: "commerce.staff_discount_uses",
    candidate_digest: candidate.candidateDigest,
    attempt_count: candidate.attemptCount,
  };
}

function relay(fixture: RelayFixture): PostgresSemanticPromotionRelay {
  return new PostgresSemanticPromotionRelay({
    controlPlanePool: fixture.controlPool,
    semanticMetadataPool: fixture.analyticalPool,
    capabilityIssuer: fixture.capabilityIssuer,
    workerId: "semantic-relay:test-replica",
    pollIntervalMs: 300_000,
  });
}

function input() {
  return {
    queryId: QUERY_ID,
    context: {
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      role: "owner" as const,
    },
    connectionId: CONNECTION_ID,
    connectorId: "lightspeed-r",
    sourceTable: "sales",
    sourceFields: ["discount_reason"],
    questionDigest: "b".repeat(64),
    requestedMetricConcept: "commerce.staff_discount_uses",
  };
}

test("source exploration returns a candidate only after control acceptance and analytical acknowledgement", async () => {
  const fixture = new RelayFixture();
  const candidateId = await relay(fixture).fileAndDeliver(input());
  assert.match(candidateId, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.equal(fixture.candidates.get(candidateId)?.delivered, true);
  assert.equal(fixture.inboxOccurrences, 1);
  assert.deepEqual(new Set(fixture.analyticalCapabilities), new Set([CAPABILITY]));
});

test("a crash after control acceptance replays without incrementing the inbox twice", async () => {
  const fixture = new RelayFixture();
  fixture.failCompleteOnce = true;
  const promotionRelay = relay(fixture);
  await assert.rejects(
    promotionRelay.fileAndDeliver(input()),
    /simulated post-accept outage/u,
  );
  assert.equal(fixture.inboxOccurrences, 1);
  assert.equal([...fixture.candidates.values()][0]?.delivered, false);

  await promotionRelay.runRecoveryCycle();
  assert.equal(fixture.inboxOccurrences, 1);
  assert.equal([...fixture.candidates.values()][0]?.delivered, true);
  assert.equal(fixture.scanCompleted, true);
  assert.equal(promotionRelay.metricsSnapshot().candidatesDelivered, 1);
});

test("recovery uses only control-issued tenant capabilities and bounded batches", async () => {
  const fixture = new RelayFixture();
  await relay(fixture).runRecoveryCycle();
  assert.equal(fixture.scanCompleted, true);
  assert.deepEqual(new Set(fixture.analyticalCapabilities), new Set([CAPABILITY]));
  assert.equal(fixture.outboxFailureCount, 0);
});
