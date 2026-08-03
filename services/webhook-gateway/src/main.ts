import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { assertEmbeddedServiceBuildIdentity } from "../../../packages/config/src/build-identity.js";
import { S3RawIngestionObjectStore } from "../../../packages/storage/src/s3-ingestion.js";
import { SupabaseMachineSessionPool } from "../../../packages/storage/src/session-credentials.js";
import { PgTransactionalDatabase } from "../../sync-workers/src/postgres.js";
import { loadWebhookGatewayConfig } from "./config.js";
import { DeputyWebhookResolver, DeputyWebhookVerifier } from "./deputy.js";
import { WebhookGatewayHandler } from "./handler.js";
import { WebhookStore } from "./store.js";
import { attestWebhookDocument, createWebhookAttestor } from "./attestation.js";
import { XeroWebhookInboxStore, XeroWebhookIngress } from "./xero-inbox.js";
import { XeroWebhookProcessor } from "./xero-processor.js";
import { LeaseBoundWebhookRawWriter } from "./raw-storage.js";

const MAX_BODY_BYTES = 1024 * 1024;

function safeErrorCode(error: unknown): string {
  const structured = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const candidate = typeof structured === "string"
    ? structured
    : error instanceof Error
      ? error.message
      : "";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(candidate)
    ? candidate
    : "gateway_stopped";
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

async function collect(request: IncomingMessage): Promise<Uint8Array> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
    throw new Error("request_too_large");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks, length));
}

async function fetchRequest(request: IncomingMessage): Promise<Request> {
  const requestHeaders = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => requestHeaders.append(name, item));
    else if (value !== undefined) requestHeaders.set(name, value);
  }
  const method = request.method ?? "GET";
  const requestBody = method === "GET" || method === "HEAD" ? undefined : await collect(request);
  const exactBody = requestBody ? new Uint8Array(requestBody.byteLength) : undefined;
  if (requestBody && exactBody) exactBody.set(requestBody);
  return new Request(new URL(request.url ?? "/", "https://webhook.albert.internal"), {
    method,
    headers: requestHeaders,
    ...(exactBody ? { body: exactBody.buffer } : {}),
  });
}

async function send(source: Response, target: ServerResponse): Promise<void> {
  const payload = Buffer.from(await source.arrayBuffer());
  const responseHeaders: Record<string, string> = {};
  source.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") responseHeaders[name] = value;
  });
  responseHeaders["content-length"] = String(payload.byteLength);
  target.writeHead(source.status, responseHeaders);
  target.end(payload);
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => {
    const forceClose = setTimeout(() => server.closeAllConnections(), 12_000);
    forceClose.unref?.();
    server.close((error) => {
      clearTimeout(forceClose);
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function runWebhookGateway(): Promise<void> {
  const releaseSha = assertEmbeddedServiceBuildIdentity(process.env);
  const config = loadWebhookGatewayConfig();
  // Keep Xero's latency-bounded durable ACK pool isolated from background
  // leases and fan-out. Pool saturation in object routing must never make the
  // public ingress wait beyond Xero's five-second deadline.
  const ingressDatabase = new PgTransactionalDatabase(config.controlPlaneDatabaseUrl, {
    applicationName: `albert-webhook-ingress/${config.serviceVersion}`,
    assumedRole: "albert_webhook_control",
    maxConnections: 8,
    connectionTimeoutMs: 1_250,
    statementTimeoutMs: 2_500,
  });
  const processorDatabase = new PgTransactionalDatabase(config.controlPlaneDatabaseUrl, {
    applicationName: `albert-webhook-processor/${config.serviceVersion}`,
    assumedRole: "albert_webhook_control",
    maxConnections: 4,
    connectionTimeoutMs: 3_000,
    statementTimeoutMs: 14_000,
  });
  const rawSessionPool = new SupabaseMachineSessionPool(config.rawStorage);
  const rawObjectStore = new S3RawIngestionObjectStore(
    config.rawStorage,
    undefined,
    { sessionPool: rawSessionPool },
  );
  const attestor = createWebhookAttestor({
    keyId: config.webhookAttestationKeyId,
    encodedSecret: config.webhookAttestationSecret,
  });
  const routeStore = new WebhookStore(processorDatabase, attestor);
  const rawWriter = new LeaseBoundWebhookRawWriter(
    config.rawStorage,
    routeStore,
    rawSessionPool,
  );
  const ingressInbox = new XeroWebhookInboxStore(ingressDatabase, attestor);
  const processorInbox = new XeroWebhookInboxStore(processorDatabase, attestor);
  const xeroIngress = new XeroWebhookIngress({
    signingKey: config.xeroWebhookSigningKey,
    keyring: config.xeroWebhookInboxKeyring,
    encryptedRetentionDays: config.xeroWebhookEncryptedRetentionDays,
    metadataRetentionDays: config.xeroWebhookMetadataRetentionDays,
    persistenceTimeoutMs: config.xeroWebhookPersistenceTimeoutMs,
  }, ingressInbox);
  const xeroProcessor = new XeroWebhookProcessor({
    config: {
      ...config.xeroWebhookProcessor,
      keyring: config.xeroWebhookInboxKeyring,
      serviceVersion: config.serviceVersion,
      ...(config.deploymentId ? { deploymentId: config.deploymentId } : {}),
    },
    inbox: processorInbox,
    routes: routeStore,
    raw: rawWriter,
  });
  const handler = new WebhookGatewayHandler({
    store: routeStore,
    xero: xeroIngress,
    deputy: {
      resolver: new DeputyWebhookResolver(processorDatabase, attestor),
      verifier: new DeputyWebhookVerifier({
        encryptionKey: config.deputyWebhookEncryptionKey,
        keyId: config.deputyWebhookEncryptionKeyId,
        encryptionKeys: config.deputyWebhookEncryptionKeys,
        maxClockSkewMs: config.deputyWebhookMaxSkewMs,
      }),
    },
    raw: rawWriter,
  });
  const dependenciesReady = async () => {
    const deputyKeyIds = [...config.deputyWebhookEncryptionKeys.keys()].sort();
    const { document, proof } = attestWebhookDocument(
      attestor,
      "system.ready",
      attestor.keyId,
      {
        version: 1,
        operation: "system.ready",
        attestationKeyId: attestor.keyId,
        deputyKeyIds,
      },
    );
    await Promise.all([
      ingressDatabase.ping(),
      processorDatabase.query(
        `select control_plane.assert_attested_webhook_gateway_ready(
           $1, $2, $3, $4, $5
         )`,
        [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
      ),
      rawObjectStore.ready(),
      processorDatabase.query(
        "select control_plane.assert_raw_storage_session_authority_ready('webhook')",
      ),
      xeroProcessor.assertReady(),
    ]);
  };
  const stop = new AbortController();
  let processorError: unknown;
  // Attach both outcomes immediately so an early worker failure can never
  // become an unhandled rejection. A stopped worker makes the whole gateway
  // unready: durable ACKs without a live drain path would only hide backlog.
  const processorRun = xeroProcessor.run(stop.signal).then(
    () => {
      if (!stop.signal.aborted) {
        processorError = new Error("xero_webhook_processor_stopped");
        stop.abort();
      }
    },
    (error: unknown) => {
      processorError = error;
      stop.abort();
    },
  );

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "https://webhook.albert.internal").pathname;
      if (request.method === "GET" && pathname === "/livez") {
        json(response, 200, { live: true, service: "albert-webhook-gateway" });
        return;
      }
      if (request.method === "GET" && pathname === "/readyz") {
        try {
          await dependenciesReady();
          json(response, 200, {
            ready: true,
            runtime: "webhook-gateway",
            releaseSha,
            deploymentId: config.deploymentId ?? null,
          });
        } catch {
          json(response, 503, { ready: false });
        }
        return;
      }
      await send(await handler.handle(await fetchRequest(request)), response);
    })().catch((error) => {
      if (!response.headersSent) {
        json(response, error instanceof Error && error.message === "request_too_large" ? 413 : 500, {
          error: error instanceof Error && error.message === "request_too_large"
            ? "payload_too_large"
            : "internal_error",
        });
      } else {
        response.destroy();
      }
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
  server.maxHeadersCount = 100;

  const shutdown = () => stop.abort();
  let serverError: unknown;
  const handleServerError = (error: Error) => {
    serverError ??= error;
    stop.abort();
  };
  server.on("error", handleServerError);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  let terminalError: unknown;
  try {
    await dependenciesReady();
    await new Promise<void>((resolve, reject) => {
      const startupError = (error: Error) => reject(error);
      server.once("error", startupError);
      server.listen(config.port, "0.0.0.0", () => {
        server.off("error", startupError);
        resolve();
      });
    });
    if (!stop.signal.aborted) {
      await new Promise<void>((resolve) => {
        stop.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  } catch (error) {
    terminalError = error;
  } finally {
    stop.abort();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    server.off("error", handleServerError);
    const serviceCleanup = await Promise.allSettled([
      closeServer(server),
      processorRun,
    ]);
    const serviceCleanupFailure = serviceCleanup.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    terminalError ??= serviceCleanupFailure?.reason;
    rawObjectStore.destroy();
    const databaseCleanup = await Promise.allSettled([
      ingressDatabase.close(),
      processorDatabase.close(),
    ]);
    const databaseCleanupFailure = databaseCleanup.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    terminalError ??= databaseCleanupFailure?.reason;
  }
  if (processorError !== undefined) throw processorError;
  if (serverError !== undefined) throw serverError;
  if (terminalError !== undefined) throw terminalError;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runWebhookGateway().catch((error) => {
    console.error("Albert webhook gateway stopped", {
      code: safeErrorCode(error),
    });
    process.exitCode = 1;
  });
}
