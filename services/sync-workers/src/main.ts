import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  DefaultSyncOrchestrator,
  PgmqDurableSyncQueue,
} from "../../../packages/queue/src/index.js";
import {
  RawBatchWriter,
  S3RawObjectStore,
} from "../../../packages/storage/src/index.js";
import { AnalyticalLandingStore } from "./analytical-store.js";
import { loadSyncWorkerConfig } from "./config.js";
import {
  ProductionConnectorFactory,
  ProductionConnectorRegistry,
} from "./connector-factory.js";
import { ControlPlaneStore } from "./control-plane-store.js";
import {
  AesKeyWrapper,
  CredentialVaultFactory,
  EnvelopeCryptography,
} from "./credential-vault.js";
import { DisconnectStore, OAuthWorkerHttpHandler } from "./oauth-http.js";
import { OAuthSessionStore } from "./oauth-session-store.js";
import {
  DeputyWebhookMaterialStore,
  DeputyWebhookSetupCoordinator,
} from "./deputy-webhooks.js";
import { PgTransactionalDatabase } from "./postgres.js";
import { SyncWorkerService } from "./service.js";
import { SyncJobProcessor } from "./worker.js";

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

export async function runSyncWorker(): Promise<void> {
  const config = loadSyncWorkerConfig();
  const controlDb = new PgTransactionalDatabase(config.controlPlaneDatabaseUrl, {
    applicationName: `albert-sync-worker/${config.serviceVersion}`,
    assumedRole: "albert_sync_control",
    maxConnections: 12,
  });
  const analyticalDb = new PgTransactionalDatabase(config.analyticalDatabaseUrl, {
    applicationName: `albert-ingest/${config.serviceVersion}`,
    assumedRole: "ingest_rw",
    maxConnections: 8,
  });
  const queue = new PgmqDurableSyncQueue(controlDb);
  const control = new ControlPlaneStore(controlDb);
  const analytical = new AnalyticalLandingStore(analyticalDb, config.mappingVersion);
  const cryptography = new EnvelopeCryptography(new AesKeyWrapper(
    config.tokenEncryptionKey,
    config.tokenKeyReference,
    config.tokenKeyVersion,
  ));
  const credentialVaults = new CredentialVaultFactory(controlDb, cryptography);
  const connectorFactory = new ProductionConnectorFactory(config);
  const registry = new ProductionConnectorRegistry(connectorFactory, credentialVaults.reader());
  const rawObjectStore = new S3RawObjectStore(config.rawStorage);
  const rawWriter = new RawBatchWriter(
    rawObjectStore,
    control,
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
    { xeroDailyRequestLimit: config.xeroDailyRequestLimit },
  );
  const service = new SyncWorkerService(config.workerId, queue, processor, {
    visibilityTimeoutSeconds: 900,
    emptyPollDelayMs: 500,
  });
  const deputyWebhookMaterials = new DeputyWebhookMaterialStore(
    controlDb,
    config.deputyWebhookEncryptionKey,
    config.deputyWebhookEncryptionKeyId,
    config.webhookGatewayPublicUrl,
    new Map(
      [...config.deputyWebhookEncryptionKeys]
        .filter(([keyId]) => keyId !== config.deputyWebhookEncryptionKeyId),
    ),
  );
  const oauth = new OAuthWorkerHttpHandler({
    oauthWorkerSigningSecret: config.oauthWorkerSigningSecret,
    allowedRedirectUris: config.oauthRedirectUris,
    sessions: new OAuthSessionStore(controlDb, cryptography),
    credentialVaults,
    connectors: connectorFactory,
    disconnects: new DisconnectStore(controlDb),
    deputyWebhooks: new DeputyWebhookSetupCoordinator(deputyWebhookMaterials),
  });

  const dependenciesReady = async () => {
    await Promise.all([
      controlDb.ping(),
      analyticalDb.ping(),
      queue.preflight(),
      rawObjectStore.ready(),
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
            json(response, 200, { ready: true, workerId: health.workerId, activeJobs: health.activeJobs });
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

  const abort = new AbortController();
  let deputyRewrapRun: Promise<void> = Promise.resolve();
  let shuttingDown = false;
  const beginShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    abort.abort();
    void closeServer(server);
  };
  process.once("SIGINT", beginShutdown);
  process.once("SIGTERM", beginShutdown);

  const startedAt = service.health().startedAt;
  const heartbeat = async () => {
    const health = service.health();
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
          ready: health.ready,
          lastClaimAt: health.lastClaimAt,
          lastCompletionAt: health.lastCompletionAt,
          lastErrorCode: health.lastErrorCode,
        }),
      ],
    );
  };

  try {
    await listen(server, config.port);
    deputyRewrapRun = (async () => {
      while (!abort.signal.aborted) {
        const rewrapped = await deputyWebhookMaterials.rewrapPreviousMaterials(100);
        if (rewrapped < 100) return;
      }
    })().catch((error) => {
      console.error("Deputy webhook material rewrap stopped", {
        code: error instanceof Error ? error.message.split(":", 1)[0] : "unknown_error",
      });
    });
    const heartbeatTimer = setInterval(() => void heartbeat().catch(() => undefined), 15_000);
    heartbeatTimer.unref();
    try {
      await heartbeat();
      await service.run(abort.signal);
    } finally {
      clearInterval(heartbeatTimer);
    }
  } finally {
    abort.abort();
    await deputyRewrapRun;
    process.off("SIGINT", beginShutdown);
    process.off("SIGTERM", beginShutdown);
    if (server.listening) await closeServer(server);
    rawObjectStore.destroy();
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
