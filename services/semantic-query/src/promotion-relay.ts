import { ulid } from "ulid";
import type { PgClientLike, PgPoolLike, SemanticAnalyticalCapabilityIssuer } from "./database.js";
import type { TrustedToolContext } from "./types.js";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const WORKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export type SemanticPromotionCandidateInput = Readonly<{
  queryId: string;
  context: TrustedToolContext;
  connectionId: string;
  connectorId: string;
  sourceTable: string;
  sourceFields: readonly string[];
  questionDigest: string;
  requestedMetricConcept?: string;
}>;

type CandidateClaim = Readonly<{
  candidateId: string;
  queryId: string;
  connectionId: string;
  connectorId: string;
  sourceTable: string;
  sourceFields: readonly string[];
  questionDigest: string;
  requestedMetricConcept?: string;
  candidateDigest: string;
  attemptCount: number;
}>;

type TenantScanLease = Readonly<{
  tenantId: string;
  leaseToken: string;
  analyticalCapability: string;
}>;

export type SemanticPromotionRelayMetrics = Readonly<{
  cycles: number;
  tenantsScanned: number;
  candidatesClaimed: number;
  candidatesDelivered: number;
  candidatesFailed: number;
  lastCycleCompletedAt?: string;
  lastErrorCode?: string;
}>;

export class PostgresSemanticPromotionRelay {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopping = false;
  private metrics: SemanticPromotionRelayMetrics = {
    cycles: 0,
    tenantsScanned: 0,
    candidatesClaimed: 0,
    candidatesDelivered: 0,
    candidatesFailed: 0,
  };

  constructor(private readonly options: Readonly<{
    controlPlanePool: PgPoolLike;
    semanticMetadataPool: PgPoolLike;
    capabilityIssuer: SemanticAnalyticalCapabilityIssuer;
    workerId: string;
    pollIntervalMs?: number;
    tenantBatchSize?: number;
    candidateBatchSize?: number;
    leaseSeconds?: number;
    onBackgroundError?: (code: string) => void;
  }>) {
    if (!WORKER_PATTERN.test(options.workerId)) throw new Error("Semantic promotion relay worker id is invalid.");
    boundedInteger(options.pollIntervalMs ?? 5_000, 250, 300_000, "poll interval");
    boundedInteger(options.tenantBatchSize ?? 10, 1, 50, "tenant batch size");
    boundedInteger(options.candidateBatchSize ?? 20, 1, 50, "candidate batch size");
    boundedInteger(options.leaseSeconds ?? 90, 15, 180, "lease duration");
  }

  start(): void {
    if (this.stopping || this.timer || this.inFlight) return;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  metricsSnapshot(): SemanticPromotionRelayMetrics {
    return { ...this.metrics };
  }

  async ready(): Promise<boolean> {
    try {
      const [controlReady, analyticalReady] = await Promise.all([
        withRole(this.options.controlPlanePool, "albert_semantic_control", async (client) => {
          const result = await client.query(
            "SELECT control_plane.assert_semantic_promotion_relay_ready() AS ready",
          );
          return result.rows[0]?.ready === true;
        }, true),
        withRole(this.options.semanticMetadataPool, "semantic_meta_rw", async (client) => {
          const result = await client.query(
            "SELECT semantic_internal.assert_promotion_relay_ready() AS ready",
          );
          return result.rows[0]?.ready === true;
        }, true),
      ]);
      return controlReady && analyticalReady;
    } catch {
      return false;
    }
  }

  /**
   * Persists and projects one source-exploration candidate.  Returning from
   * this method is the receipt boundary used by the user-visible response.
   */
  async fileAndDeliver(input: SemanticPromotionCandidateInput): Promise<string> {
    assertCandidateInput(input);
    const candidateId = ulid();
    const sourceFields = canonicalSourceFields(input.sourceFields);
    const capability = await this.options.capabilityIssuer.issue({
      tenantId: input.context.tenantId,
      scope: "semantic_metadata",
      evidence: {
        conversationId: input.context.conversationId,
        turnId: input.context.turnId,
      },
    });
    await withAnalyticalCapability(
      this.options.semanticMetadataPool,
      capability,
      async (client) => {
        const result = await client.query(
          `SELECT semantic_internal.enqueue_promotion_candidate(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
           ) AS candidate_digest`,
          [
            candidateId,
            input.queryId,
            input.context.conversationId,
            input.context.turnId,
            input.connectionId,
            input.connectorId,
            input.sourceTable,
            sourceFields,
            input.questionDigest,
            input.requestedMetricConcept ?? null,
          ],
        );
        requireDigest(result.rows[0]?.candidate_digest, "candidate digest");
      },
    );
    const leaseToken = ulid();
    const claim = await this.claimExact(
      input.context.tenantId,
      candidateId,
      leaseToken,
      capability,
    );
    if (claim.status === "delivered") return candidateId;
    if (claim.status !== "claimed" || !claim.candidate) {
      throw new Error("Semantic promotion candidate is already leased for recovery.");
    }
    await this.deliverClaim(
      input.context.tenantId,
      claim.candidate,
      leaseToken,
      capability,
    );
    return candidateId;
  }

  /** Runs one bounded drain pass; exposed for deterministic process tests. */
  async runRecoveryCycle(): Promise<void> {
    const leases = await this.claimTenantScans();
    let scanned = 0;
    let claimed = 0;
    let delivered = 0;
    let failed = 0;
    for (const lease of leases) {
      scanned += 1;
      try {
        const batchToken = ulid();
        const candidates = await this.claimDue(lease, batchToken);
        claimed += candidates.length;
        let tenantDelivered = 0;
        let tenantFailed = 0;
        for (const candidate of candidates) {
          try {
            await this.deliverClaim(
              lease.tenantId,
              candidate,
              batchToken,
              lease.analyticalCapability,
            );
            tenantDelivered += 1;
          } catch (error) {
            tenantFailed += 1;
            await this.failCandidate(
              lease.tenantId,
              candidate,
              batchToken,
              lease.analyticalCapability,
              safeRelayErrorCode(error),
            ).catch(() => undefined);
          }
        }
        delivered += tenantDelivered;
        failed += tenantFailed;
        await this.completeTenantScan(
          lease,
          candidates.length,
          tenantDelivered,
          tenantFailed,
        );
      } catch (error) {
        failed += 1;
        const code = safeRelayErrorCode(error);
        await this.failTenantScan(lease, code).catch(() => undefined);
        this.options.onBackgroundError?.(code);
      }
    }
    this.metrics = {
      cycles: this.metrics.cycles + 1,
      tenantsScanned: this.metrics.tenantsScanned + scanned,
      candidatesClaimed: this.metrics.candidatesClaimed + claimed,
      candidatesDelivered: this.metrics.candidatesDelivered + delivered,
      candidatesFailed: this.metrics.candidatesFailed + failed,
      lastCycleCompletedAt: new Date().toISOString(),
      ...(failed ? { lastErrorCode: "PROMOTION_RECOVERY_PARTIAL_FAILURE" } : {}),
    };
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.runRecoveryCycle()
        .catch((error) => {
          const code = safeRelayErrorCode(error);
          this.metrics = { ...this.metrics, lastErrorCode: code };
          this.options.onBackgroundError?.(code);
        })
        .finally(() => {
          this.inFlight = undefined;
          this.schedule(this.options.pollIntervalMs ?? 5_000);
        });
    }, delayMs);
    this.timer.unref();
  }

  private async claimExact(
    tenantId: string,
    candidateId: string,
    leaseToken: string,
    capability: string,
  ): Promise<Readonly<{ status: "claimed" | "busy" | "delivered"; candidate?: CandidateClaim }>> {
    return withAnalyticalCapability(this.options.semanticMetadataPool, capability, async (client) => {
      const result = await client.query(
        "SELECT * FROM semantic_internal.claim_promotion_candidate($1,$2,$3,$4)",
        [candidateId, this.options.workerId, leaseToken, this.options.leaseSeconds ?? 90],
      );
      const row = result.rows[0];
      const status = requiredString(row?.claim_status, "candidate claim status");
      if (status === "delivered") {
        requireUlid(row?.control_inbox_item_id, "control inbox item id");
        return { status };
      }
      if (status === "busy") return { status };
      if (status !== "claimed") throw new Error("Analytical cell returned an invalid promotion claim status.");
      return { status, candidate: parseCandidateClaim(row, tenantId) };
    });
  }

  private async claimTenantScans(): Promise<readonly TenantScanLease[]> {
    return withRole(this.options.controlPlanePool, "albert_semantic_control", async (client) => {
      const result = await client.query(
        "SELECT * FROM control_plane.claim_semantic_promotion_relay_tenants($1,$2,$3)",
        [
          this.options.workerId,
          this.options.tenantBatchSize ?? 10,
          this.options.leaseSeconds ?? 90,
        ],
      );
      return result.rows.map((row) => ({
        tenantId: requireUlid(row.tenant_id, "relay tenant id"),
        leaseToken: requireUlid(row.lease_token, "relay lease token"),
        analyticalCapability: requiredCapability(row.analytical_capability),
      }));
    });
  }

  private async claimDue(
    lease: TenantScanLease,
    batchToken: string,
  ): Promise<readonly CandidateClaim[]> {
    return withAnalyticalCapability(
      this.options.semanticMetadataPool,
      lease.analyticalCapability,
      async (client) => {
        const result = await client.query(
          "SELECT * FROM semantic_internal.claim_due_promotion_candidates($1,$2,$3,$4)",
          [
            this.options.workerId,
            batchToken,
            this.options.candidateBatchSize ?? 20,
            this.options.leaseSeconds ?? 90,
          ],
        );
        return result.rows.map((row) => parseCandidateClaim(row, lease.tenantId));
      },
    );
  }

  private async deliverClaim(
    tenantId: string,
    candidate: CandidateClaim,
    leaseToken: string,
    capability: string,
  ): Promise<void> {
    let receipt: Readonly<{ inboxItemId: string }>;
    try {
      receipt = await withRole(
        this.options.controlPlanePool,
        "albert_semantic_control",
        async (client) => {
          const result = await client.query(
            `SELECT * FROM control_plane.accept_semantic_promotion_candidate(
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
             )`,
            [
              tenantId,
              candidate.candidateId,
              candidate.queryId,
              candidate.connectionId,
              candidate.connectorId,
              candidate.sourceTable,
              candidate.sourceFields,
              candidate.questionDigest,
              candidate.requestedMetricConcept ?? null,
              candidate.candidateDigest,
            ],
          );
          return {
            inboxItemId: requireUlid(
              result.rows[0]?.semantic_inbox_item_id,
              "semantic inbox item id",
            ),
          };
        },
      );
    } catch (error) {
      await this.failCandidate(
        tenantId,
        candidate,
        leaseToken,
        capability,
        safeRelayErrorCode(error),
      ).catch(() => undefined);
      throw error;
    }
    await withAnalyticalCapability(this.options.semanticMetadataPool, capability, async (client) => {
      const result = await client.query(
        "SELECT semantic_internal.complete_promotion_candidate($1,$2,$3,$4) AS completed",
        [candidate.candidateId, this.options.workerId, leaseToken, receipt.inboxItemId],
      );
      if (result.rows[0]?.completed !== true) {
        throw new Error("Analytical outbox did not acknowledge semantic promotion delivery.");
      }
    });
  }

  private async failCandidate(
    _tenantId: string,
    candidate: CandidateClaim,
    leaseToken: string,
    capability: string,
    errorCode: string,
  ): Promise<void> {
    const retryAfterSeconds = boundedBackoffSeconds(candidate.attemptCount);
    await withAnalyticalCapability(this.options.semanticMetadataPool, capability, async (client) => {
      await client.query(
        "SELECT semantic_internal.fail_promotion_candidate($1,$2,$3,$4,$5)",
        [candidate.candidateId, this.options.workerId, leaseToken, errorCode, retryAfterSeconds],
      );
    });
  }

  private async completeTenantScan(
    lease: TenantScanLease,
    claimed: number,
    delivered: number,
    failed: number,
  ): Promise<void> {
    await withRole(this.options.controlPlanePool, "albert_semantic_control", async (client) => {
      await client.query(
        "SELECT control_plane.complete_semantic_promotion_relay_tenant($1,$2,$3,$4,$5,$6)",
        [lease.tenantId, this.options.workerId, lease.leaseToken, claimed, delivered, failed],
      );
    });
  }

  private async failTenantScan(lease: TenantScanLease, errorCode: string): Promise<void> {
    await withRole(this.options.controlPlanePool, "albert_semantic_control", async (client) => {
      await client.query(
        "SELECT control_plane.fail_semantic_promotion_relay_tenant($1,$2,$3,$4,$5)",
        [lease.tenantId, this.options.workerId, lease.leaseToken, errorCode, 30],
      );
    });
  }
}

async function withRole<T>(
  pool: PgPoolLike,
  role: "albert_semantic_control" | "semantic_meta_rw",
  operation: (client: PgClientLike) => Promise<T>,
  readOnly = false,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? "BEGIN TRANSACTION READ ONLY" : "BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    client.release();
  }
}

async function withAnalyticalCapability<T>(
  pool: PgPoolLike,
  capability: string,
  operation: (client: PgClientLike) => Promise<T>,
): Promise<T> {
  return withRole(pool, "semantic_meta_rw", async (client) => {
    await client.query("SELECT set_config('albert.tenant_capability',$1,true)", [capability]);
    return operation(client);
  });
}

function parseCandidateClaim(row: Readonly<Record<string, unknown>>, expectedTenantId: string): CandidateClaim {
  // expectedTenantId is intentionally not accepted from the analytical row;
  // the signed capability selected the RLS tenant before this projection.
  requireUlid(expectedTenantId, "expected tenant id");
  const requestedMetricConcept = row.requested_metric_concept;
  if (requestedMetricConcept !== null && requestedMetricConcept !== undefined &&
      (typeof requestedMetricConcept !== "string" || !/^[a-z][a-z0-9_.]{0,159}$/u.test(requestedMetricConcept))) {
    throw new Error("Analytical cell returned an invalid requested metric concept.");
  }
  const sourceFields = row.source_fields;
  if (!Array.isArray(sourceFields) || !sourceFields.every((field) => typeof field === "string")) {
    throw new Error("Analytical cell returned invalid promotion source fields.");
  }
  const attemptCount = Number(row.attempt_count);
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new Error("Analytical cell returned an invalid promotion attempt count.");
  }
  return {
    candidateId: requireUlid(row.candidate_id, "candidate id"),
    queryId: requireUlid(row.query_id, "query id"),
    connectionId: requireUlid(row.connection_id, "connection id"),
    connectorId: requiredString(row.connector_id, "connector id"),
    sourceTable: requiredString(row.source_table, "source table"),
    sourceFields: canonicalSourceFields(sourceFields),
    questionDigest: requireDigest(row.question_digest, "question digest"),
    ...(typeof requestedMetricConcept === "string" ? { requestedMetricConcept } : {}),
    candidateDigest: requireDigest(row.candidate_digest, "candidate digest"),
    attemptCount,
  };
}

function assertCandidateInput(input: SemanticPromotionCandidateInput): void {
  requireUlid(input.queryId, "query id");
  requireUlid(input.context.tenantId, "tenant id");
  requireUlid(input.context.conversationId, "conversation id");
  requireUlid(input.context.turnId, "turn id");
  requireUlid(input.connectionId, "connection id");
  requireDigest(input.questionDigest, "question digest");
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(input.connectorId) ||
      !/^[a-z_][a-z0-9_]{0,62}$/u.test(input.sourceTable)) {
    throw new Error("Semantic promotion source identity is invalid.");
  }
  if (input.requestedMetricConcept !== undefined &&
      !/^[a-z][a-z0-9_.]{0,159}$/u.test(input.requestedMetricConcept)) {
    throw new Error("Semantic promotion requested metric concept is invalid.");
  }
  canonicalSourceFields(input.sourceFields);
}

function canonicalSourceFields(values: readonly string[]): readonly string[] {
  const fields = [...new Set(values.length ? values : ["*"])].sort();
  if (fields.length < 1 || fields.length > 20 ||
      fields.some((field) => field !== "*" && !/^[a-z_][a-z0-9_]{0,62}$/u.test(field)) ||
      (fields.includes("*") && fields.length !== 1)) {
    throw new Error("Semantic promotion source fields are invalid.");
  }
  return fields;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}.`);
  return value;
}

function requireUlid(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!ULID_PATTERN.test(parsed)) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function requireDigest(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!DIGEST_PATTERN.test(parsed)) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function requiredCapability(value: unknown): string {
  const parsed = requiredString(value, "analytical capability");
  if (parsed.length < 100 || parsed.length > 4_096) throw new Error("Invalid analytical capability.");
  return parsed;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Semantic promotion relay ${label} is invalid.`);
  }
  return value;
}

function boundedBackoffSeconds(attemptCount: number): number {
  return Math.min(300, Math.max(1, 2 ** Math.min(8, Math.max(0, attemptCount - 1))));
}

function safeRelayErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as Readonly<{ code?: unknown }>).code ?? "")
    : "";
  if (code === "42501") return "PROMOTION_AUTHORIZATION_REJECTED";
  if (code === "55000") return "PROMOTION_LIFECYCLE_FENCED";
  if (code === "P0002") return "PROMOTION_CANDIDATE_MISSING";
  if (code === "22023") return "PROMOTION_PAYLOAD_REJECTED";
  if (code.startsWith("08") || code === "57P01") return "PROMOTION_DATABASE_UNAVAILABLE";
  return "PROMOTION_DELIVERY_FAILED";
}
