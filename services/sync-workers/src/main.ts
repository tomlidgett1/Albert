import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { assertEmbeddedServiceBuildIdentity } from "../../../packages/config/src/build-identity.js";
import {
  DefaultSyncOrchestrator,
  PgmqDurableSyncQueue,
} from "../../../packages/queue/src/index.js";
import { S3RawIngestionObjectStore } from "../../../packages/storage/src/s3-ingestion.js";
import { SupabaseMachineSessionPool } from "../../../packages/storage/src/session-credentials.js";
import { AnalyticalLandingStore } from "./analytical-store.js";
import { loadSyncWorkerConfig } from "./config.js";
import {
  ProductionConnectorFactory,
  ProductionConnectorRegistry,
} from "./connector-factory.js";
import { ControlPlaneStore } from "./control-plane-store.js";
import {
  AesKeyringWrapper,
  CredentialVaultFactory,
  EnvelopeCryptography,
} from "./credential-vault.js";
import { OAuthWorkerHttpHandler } from "./oauth-http.js";
import { OAuthSessionStore } from "./oauth-session-store.js";
import { PgTransactionalDatabase } from "./postgres.js";
import { LeaseBoundSyncRawWriter } from "./raw-storage.js";
import { SyncWorkerService } from "./service.js";
import {
  OAuthTokenKekRotationService,
  PostgresOAuthTokenKekRotationStore,
} from "./token-kek-rotation.js";
import { SyncJobProcessor } from "./worker.js";
import {
  loadVendorAttestationRelayConfig,
  VendorAttestationRelay,
} from "./vendor-attestation-relay.js";

const MAX_INTERNAL_BODY_BYTES = 64 * 1024;

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function body(request: IncomingMessage): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_INTERNAL_BODY_BYTES) {
    throw new Error("request_too_large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_INTERNAL_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function toFetchRequest(request: IncomingMessage): Promise<Request> {
  const url = new URL(request.url ?? "/", "http://sync-worker.internal");
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const requestBody = await body(request);
  const method = request.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: requestBody }),
  });
}

async function writeFetchResponse(source: Response, target: ServerResponse): Promise<void> {
  const payload = Buffer.from(await source.arrayBuffer());
  const headers: Record<string, string> = {};
  source.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") headers[name] = value;
  });
  headers["content-length"] = String(payload.byteLength);
  target.writeHead(source.status, headers);
  target.end(payload);
}

async function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "0.0.0.0");
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function prometheusLabel(value: string): string {
  return JSON.stringify(value);
}

export async function runSyncWorker(): Promise<void> {
  const releaseSha = assertEmbeddedServiceBuildIdentity(process.env);
  const deploymentId = process.env.ALBERT_DEPLOYMENT_ID?.trim() || null;
  const config = loadSyncWorkerConfig();
  const controlDb = new PgTransactionalDatabase(config.controlPlaneDatabaseUrl, {
    applicationName: `albert-sync-worker/${config.serviceVersion}`,
    assumedRole: "albert_sync_control",
    maxConnections: config.workerConcurrency + 4,
  });
  const analyticalDb = new PgTransactionalDatabase(config.analyticalDatabaseUrl, {
    applicationName: `albert-ingest/${config.serviceVersion}`,
    assumedRole: "ingest_rw",
    maxConnections: config.workerConcurrency + 2,
  });
  const queue = new PgmqDurableSyncQueue(controlDb);
  const control = new ControlPlaneStore(controlDb);
  const analytical = new AnalyticalLandingStore(analyticalDb, config.mappingVersion);
  const tokenKeyWrapper = new AesKeyringWrapper({
    currentKeyReference: config.tokenKeyReference,
    currentKeyVersion: config.tokenKeyVersion,
    encodedKeys: config.tokenEncryptionKeys,
  });
  const cryptography = new EnvelopeCryptography(tokenKeyWrapper);
  const tokenKekRotation = new OAuthTokenKekRotationService(
    new PostgresOAuthTokenKekRotationStore(controlDb),
    tokenKeyWrapper,
  );
  const credentialVaults = new CredentialVaultFactory(controlDb, cryptography);
  const vendorAttestationRelayConfig = loadVendorAttestationRelayConfig();
  const vendorAttestationRelay = vendorAttestationRelayConfig
    ? new VendorAttestationRelay({
        database: controlDb,
        vault: credentialVaults.reader(),
        workerId: config.workerId,
        config: vendorAttestationRelayConfig,
      })
    : null;
  const connectorFactory = new ProductionConnectorFactory(config);
  const registry = new ProductionConnectorRegistry(connectorFactory, credentialVaults.reader());
  const rawSessionPool = new SupabaseMachineSessionPool(config.rawStorage);
  const rawObjectStore = new S3RawIngestionObjectStore(
    config.rawStorage,
    undefined,
    { sessionPool: rawSessionPool },
  );
  const rawWriter = new LeaseBoundSyncRawWriter(
    config.rawStorage,
    control,
    control,
    rawSessionPool,
  );
  const orchestrator = new DefaultSyncOrchestrator(queue);
  const processor = new SyncJobProcessor(
    queue,
    orchestrator,
    registry,
    control,
    analytical,
    rawWriter,
    config.workerId,
    { vendorRateBudgetOptions: { dailyRequestLimit: config.xeroDailyRequestLimit } },
  );
  const service = new SyncWorkerService(config.workerId, queue, processor, {
    visibilityTimeoutSeconds: 900,
    emptyPollDelayMs: 500,
    concurrency: config.workerConcurrency,
  });
  const oauth = new OAuthWorkerHttpHandler({
    oauthWorkerSigningSecret: config.oauthWorkerSigningSecret,
    allowedRedirectUris: config.oauthRedirectUris,
    sessions: new OAuthSessionStore(controlDb, cryptography),
    connectors: connectorFactory,
  });

  const dependenciesReady = async () => {
    await Promise.all([
      controlDb.ping(),
      analyticalDb.ping(),
      queue.preflight(),
      rawObjectStore.ready(),
      controlDb.query("select control_plane.assert_raw_storage_session_authority_ready('sync')"),
      tokenKekRotation.assertReady(),
      ...(vendorAttestationRelay ? [vendorAttestationRelay.ready()] : []),
      controlDb.query("select control_plane.assert_analytical_capability_issuer_ready()"),
      analyticalDb.query("select capability_internal.assert_verifier_ready()"),
    ]);
  };
  await dependenciesReady();

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://sync-worker.internal").pathname;
      if (request.method === "GET" && pathname === "/livez") {
        json(response, 200, { live: true, service: "albert-sync-worker" });
        return;
      }
      if (request.method === "GET" && pathname === "/readyz") {
        const health = service.health();
        if (health.ready) {
          try {
            await dependenciesReady();
            json(response, 200, {
              ready: true,
              runtime: "sync-worker",
              workerId: health.workerId,
              activeJobs: health.activeJobs,
              releaseSha,
              deploymentId,
            });
            return;
          } catch {
            // Fall through to the intentionally non-sensitive readiness result.
          }
        }
        json(response, 503, { ready: false });
        return;
      }
      if (pathname.startsWith("/v1/oauth/")) {
        await writeFetchResponse(await oauth.handle(await toFetchRequest(request)), response);
        return;
      }
      json(response, 404, { error: "not_found" });
    })().catch((error) => {
      if (!response.headersSent) {
        json(response, error instanceof Error && error.message === "request_too_large" ? 413 : 500, {
          error: error instanceof Error && error.message === "request_too_large"
            ? "request_too_large"
            : "internal_error",
        });
      } else {
        response.destroy();
      }
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
  server.maxHeadersCount = 100;

  const metricsServer = createServer({ maxHeaderSize: 4 * 1024 }, (request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://sync-worker-metrics.internal").pathname;
      if (request.method !== "GET" || pathname !== "/metrics") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found\n");
        return;
      }
      const [health, queueMetrics] = [service.health(), await queue.metrics()];
      const queueDepth = queueMetrics.reduce((total, metric) => total + metric.queueLength, 0);
      const oldestAge = queueMetrics.reduce(
        (oldest, metric) => Math.max(oldest, metric.oldestMessageAgeSeconds ?? 0),
        0,
      );
      const lines = [
        "# HELP albert_sync_worker_active_jobs Jobs currently executing in this Machine.",
        "# TYPE albert_sync_worker_active_jobs gauge",
        `albert_sync_worker_active_jobs ${health.activeJobs}`,
        "# HELP albert_sync_worker_concurrency Configured execution lanes in this Machine.",
        "# TYPE albert_sync_worker_concurrency gauge",
        `albert_sync_worker_concurrency ${health.concurrency}`,
        "# HELP albert_sync_queue_depth Total visible work across durable sync queues.",
        "# TYPE albert_sync_queue_depth gauge",
        `albert_sync_queue_depth ${queueDepth}`,
        "# HELP albert_sync_queue_oldest_age_seconds Age of the oldest visible sync job.",
        "# TYPE albert_sync_queue_oldest_age_seconds gauge",
        `albert_sync_queue_oldest_age_seconds ${oldestAge}`,
        "# HELP albert_sync_queue_sla_breached Whether visible work exceeds the configured queue SLO.",
        "# TYPE albert_sync_queue_sla_breached gauge",
        `albert_sync_queue_sla_breached ${oldestAge > config.queueSlaSeconds ? 1 : 0}`,
        ...queueMetrics.flatMap((metric) => [
          `albert_sync_queue_jobs{queue=${prometheusLabel(metric.queueName)}} ${metric.queueLength}`,
          `albert_sync_queue_age_seconds{queue=${prometheusLabel(metric.queueName)}} ${metric.oldestMessageAgeSeconds ?? 0}`,
        ]),
        "",
      ];
      const payload = lines.join("\n");
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(payload),
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(payload);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("metrics unavailable\n");
    });
  });
  metricsServer.headersTimeout = 5_000;
  metricsServer.requestTimeout = 10_000;
  metricsServer.keepAliveTimeout = 5_000;
  metricsServer.maxRequestsPerSocket = 200;
  metricsServer.maxHeadersCount = 32;

  const abort = new AbortController();
  let shuttingDown = false;
  const beginShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    abort.abort();
    void Promise.allSettled([
      ...(server.listening ? [closeServer(server)] : []),
      ...(metricsServer.listening ? [closeServer(metricsServer)] : []),
    ]);
  };
  process.once("SIGINT", beginShutdown);
  process.once("SIGTERM", beginShutdown);

  const startedAt = service.health().startedAt;
  const heartbeat = async () => {
    const health = service.health();
    const tokenKekHealth = tokenKekRotation.health();
    await controlDb.query(
      `select control_plane.heartbeat_worker(
         $1::text, $2::text, $3::text, $4::timestamptz, $5::integer, $6::jsonb
       )`,
      [
        config.workerId,
        config.serviceVersion,
        process.env.ALBERT_DEPLOYMENT_ID?.trim() || null,
        startedAt,
        health.activeJobs,
        JSON.stringify({
          service: "sync-worker",
          ready: health.ready,
          lastClaimAt: health.lastClaimAt,
          lastCompletionAt: health.lastCompletionAt,
          lastErrorCode: health.lastErrorCode,
          tokenKek: {
            currentKeyVersion: tokenKekHealth.currentKeyVersion,
            loadedOverlapKeyCount: tokenKekHealth.loadedOverlapKeyCount,
            activeEnvelopeCount: tokenKekHealth.activeEnvelopeCount,
            pendingRewrapCount: tokenKekHealth.pendingRewrapCount,
            lastRewrapAt: tokenKekHealth.lastRewrapAt,
            lastErrorCode: tokenKekHealth.lastErrorCode,
          },
        }),
      ],
    );
  };

  try {
    await Promise.all([listen(server, config.port), listen(metricsServer, config.metricsPort)]);
    const heartbeatTimer = setInterval(() => void heartbeat().catch(() => undefined), 15_000);
    heartbeatTimer.unref();
    try {
      await heartbeat();
      await Promise.all([
        service.run(abort.signal),
        tokenKekRotation.run(abort.signal),
        ...(vendorAttestationRelay ? [vendorAttestationRelay.run(abort.signal)] : []),
      ]);
    } finally {
      clearInterval(heartbeatTimer);
    }
  } finally {
    abort.abort();
    process.off("SIGINT", beginShutdown);
    process.off("SIGTERM", beginShutdown);
    if (server.listening) await closeServer(server);
    if (metricsServer.listening) await closeServer(metricsServer);
    rawObjectStore.destroy();
    vendorAttestationRelay?.destroy();
    await Promise.allSettled([controlDb.close(), analyticalDb.close()]);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runSyncWorker().catch((error) => {
    console.error("Albert sync worker stopped", {
      code: error instanceof Error ? error.message.split(":", 1)[0] : "unknown_error",
    });
    process.exitCode = 1;
  });
}
