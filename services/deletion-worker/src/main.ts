import { createServer, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { assertEmbeddedServiceBuildIdentity } from "../../../packages/config/src/build-identity.js";
import { S3RawDeletionObjectStore } from "../../../packages/storage/src/s3-deletion.js";
import { SupabaseMachineSessionPool } from "../../../packages/storage/src/session-credentials.js";
import { createServiceLogger, safeErrorEvidence } from "../../../packages/observability/src/index.js";
import { loadDeletionWorkerConfig } from "./config.js";
import { DeletionCredentialVault } from "./credential-vault.js";
import {
  deletionFailureEvidence,
  DeletionProcessor,
  ProductionCredentialRevoker,
  type DeletionProcessOutcome,
} from "./processor.js";
import { LeaseBoundRawStoragePurger } from "./raw-storage.js";
import { DeletionAnalyticalStore, DeletionControlStore } from "./store.js";
import {
  AesKeyringWrapper,
  EnvelopeCryptography,
} from "../../sync-workers/src/credential-vault.js";
import { PgTransactionalDatabase } from "../../sync-workers/src/postgres.js";

const logger = createServiceLogger("deletion-worker");

function json(response: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export type DeletionAttemptHealth = Readonly<{
  lastCompletionAt: string | null;
  lastErrorCode: string | null;
}>;

export function recordDeletionProcessOutcome(
  current: DeletionAttemptHealth,
  outcome: DeletionProcessOutcome,
  completedAt = new Date().toISOString(),
): DeletionAttemptHealth {
  if (outcome.status === "completed") {
    return Object.freeze({ lastCompletionAt: completedAt, lastErrorCode: null });
  }
  return Object.freeze({
    lastCompletionAt: current.lastCompletionAt,
    lastErrorCode: outcome.failure.code,
  });
}

export async function runDeletionWorker(): Promise<void> {
  const releaseSha = assertEmbeddedServiceBuildIdentity(process.env);
  const deploymentId = process.env.ALBERT_DEPLOYMENT_ID?.trim() || null;
  const config = loadDeletionWorkerConfig();
  const controlDb = new PgTransactionalDatabase(config.controlPlaneDatabaseUrl, {
    applicationName: `albert-deletion-control/${config.serviceVersion}`,
    maxConnections: 6,
  });
  const analyticalDb = new PgTransactionalDatabase(config.analyticalDatabaseUrl, {
    applicationName: `albert-deletion-analytical/${config.serviceVersion}`,
    maxConnections: 3,
  });
  const control = new DeletionControlStore(controlDb, config.workerId);
  const analytical = new DeletionAnalyticalStore(analyticalDb);
  const cryptography = new EnvelopeCryptography(new AesKeyringWrapper({
    currentKeyReference: config.tokenKeyReference,
    currentKeyVersion: config.tokenKeyVersion,
    encodedKeys: config.tokenEncryptionKeys,
  }));
  const rawSessionPool = new SupabaseMachineSessionPool(config.rawStorage);
  const rawObjects = new S3RawDeletionObjectStore(
    config.rawStorage,
    undefined,
    { sessionPool: rawSessionPool },
  );
  const raw = new LeaseBoundRawStoragePurger(config.rawStorage, control, rawSessionPool);
  const processor = new DeletionProcessor(
    control,
    analytical,
    raw,
    new ProductionCredentialRevoker(
      control,
      (claim) => new DeletionCredentialVault(controlDb, cryptography, claim, config.workerId),
      config,
    ),
    config.proofHmacKey,
    releaseSha,
  );

  const dependenciesReady = async () => {
    await Promise.all([
      controlDb.ping(),
      analyticalDb.ping(),
      control.preflight(),
      analytical.preflight(),
      rawObjects.ready(),
    ]);
  };
  await dependenciesReady();

  const abort = new AbortController();
  const startedAt = new Date().toISOString();
  let activeJobs = 0;
  let lastClaimAt: string | null = null;
  let lastCompletionAt: string | null = null;
  let lastErrorCode: string | null = null;
  let ready = true;
  const workerLoop = async () => {
    while (!abort.signal.aborted) {
      try {
        const claim = await control.claim();
        if (!claim) {
          await wait(config.pollDelayMs, abort.signal);
          continue;
        }
        lastClaimAt = new Date().toISOString();
        activeJobs += 1;
        try {
          const outcome = await processor.process(claim);
          const attemptHealth = recordDeletionProcessOutcome(
            { lastCompletionAt, lastErrorCode },
            outcome,
          );
          lastCompletionAt = attemptHealth.lastCompletionAt;
          lastErrorCode = attemptHealth.lastErrorCode;
        } finally {
          activeJobs -= 1;
        }
      } catch (error) {
        const evidence = deletionFailureEvidence(error);
        lastErrorCode = evidence.code;
        logger.error("worker_loop_failed", {
          code: evidence.code,
          errorClass: evidence.errorClass,
        }, evidence.correlationId);
        await wait(Math.max(config.pollDelayMs, 1_000), abort.signal);
      }
    }
  };

  const heartbeat = async () => {
    await control.heartbeat({
      serviceVersion: releaseSha,
      deploymentId,
      startedAt,
      activeJobs,
      metadata: { ready, lastClaimAt, lastCompletionAt, lastErrorCode, service: "deletion-worker" },
    });
  };

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://deletion-worker.internal").pathname;
      if (request.method === "GET" && pathname === "/livez") {
        json(response, 200, { live: true, service: "albert-deletion-worker" });
        return;
      }
      if (request.method === "GET" && pathname === "/readyz") {
        try {
          if (!ready) throw new Error("shutting_down");
          await dependenciesReady();
          json(response, 200, {
            ready: true,
            runtime: "deletion-worker",
            workerId: config.workerId,
            activeJobs,
            releaseSha,
            deploymentId,
          });
        } catch {
          json(response, 503, { ready: false });
        }
        return;
      }
      if (request.method === "GET" && pathname === "/v1/metrics") {
        json(response, 200, { activeJobs, lastClaimAt, lastCompletionAt, lastErrorCode });
        return;
      }
      json(response, 404, { error: "not_found" });
    })().catch(() => {
      if (!response.headersSent) json(response, 500, { error: "internal_error" });
      else response.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
  server.maxHeadersCount = 100;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", () => resolve());
  });
  logger.info("worker_started", { port: config.port, workerId: config.workerId });
  const interval = setInterval(() => void heartbeat().catch(() => undefined), 30_000);
  await heartbeat();
  const loop = workerLoop();
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      if (!ready) return;
      ready = false;
      logger.info("worker_stopping", { workerId: config.workerId, activeJobs });
      abort.abort();
      clearInterval(interval);
      server.closeIdleConnections();
      server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await loop;
  await Promise.all([controlDb.close(), analyticalDb.close()]);
  rawObjects.destroy();
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  runDeletionWorker().catch((error) => {
    const evidence = deletionFailureEvidence(error);
    logger.error("worker_startup_failed", {
      ...safeErrorEvidence(error),
      code: evidence.code,
      errorClass: evidence.errorClass,
    }, evidence.correlationId);
    process.exitCode = 1;
  });
}
