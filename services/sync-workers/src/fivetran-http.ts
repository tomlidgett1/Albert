import { ulid } from "ulid";
import { verifyInternalRequest } from "../../../packages/security/src/index.js";
import {
  FIVETRAN_SERVICES,
  FivetranApiError,
  FivetranClient,
  fivetranConnectionSchema,
  isFivetranService,
  summarizeSetupTests,
  type FivetranService,
  type FivetranServiceDefinition,
} from "../../../packages/fivetran/src/index.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";

import type { DeputyFivetranCredentialBridge, NativeFivetranCredentialBridge } from "./fivetran-native-credentials.js";
import type { FivetranDestinationStore } from "./fivetran-destinations.js";
import { packageSdkProject } from "./fivetran-sdk-package.js";
import type { FivetranConnectionStore } from "./fivetran-store.js";

export type FivetranWorkerConfig = Readonly<{
  apiKey: string;
  apiSecret: string;
  groupId: string;
  destinationSchema: string;
  destinationRole?: string;
  /** Public https origin of this worker; the SDK connectors' token broker URL. */
  tokenBrokerOrigin?: string;
  /** Directory holding the Xero Connector SDK project (connector.py …). */
  sdkProjectDir?: string;
  /** Directory holding the Lightspeed R-Series Connector SDK project. */
  lightspeedSdkProjectDir?: string;
  /** Python runtime Fivetran should use for the SDK connectors. */
  sdkPythonVersion?: string;
}>;

/**
 * One entry per service Albert lands through its own Connector SDK connector:
 * the native grant it rides, the project to package, and the connector's
 * configuration keys. Everything else about the SDK path is shared.
 */
type SdkServiceDefinition = Readonly<{
  label: string;
  /** Native connector the grant lives on (control_plane.connections.connector_key). */
  bridge: NativeFivetranCredentialBridge | undefined;
  notConfigured: string;
  projectDir: string;
  /** Error when the native connection carries no vendor account reference. */
  accountMissing: string;
  configuration: (input: Readonly<{
    brokerOrigin: string; secret: string; tenantId: string; connectionId: string; externalAccountReference: string;
  }>) => Record<string, string>;
}>;

export type FivetranSyncPhase =
  | "historical"
  | "incremental"
  | "up_to_date"
  | "scheduled"
  | "paused"
  | "failed"
  | "broken";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_request");
  return value as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string, max = 500): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("invalid_request");
  return value;
}

function stateNonceHash(input: Record<string, unknown>): string {
  const value = requiredString(input, "stateNonceHash", 64);
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("oauth_state_hash_invalid");
  return value;
}

function response(value: unknown, status = 200) {
  return Response.json({ result: value }, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function errorResponse(error: string, status: number, detail?: string) {
  return Response.json(detail ? { error, detail } : { error }, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function publicError(error: unknown) {
  if (error instanceof FivetranApiError) {
    const status = error.status >= 400 && error.status < 500 ? 409 : 503;
    return errorResponse(
      status === 409 ? "fivetran_setup_rejected" : "fivetran_unavailable",
      status,
      error.message.slice(0, 280),
    );
  }
  const raw = error instanceof Error ? error.message : "fivetran_worker_error";
  const [codePart, ...detailParts] = raw.split(":");
  const code = /^(?:oauth|fivetran|invalid)_[a-z0-9_.-]+$/.test(codePart)
    ? codePart
    : "fivetran_worker_error";
  const detail = detailParts.join(":").trim().slice(0, 280) || undefined;
  const status = /actor_not|unauthorised/.test(code)
    ? 403
    : /not_found/.test(code)
      ? 404
      : /invalid|mismatch|expired|incomplete/.test(code)
        ? 409
        : 503;
  return errorResponse(code.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 100), status, detail);
}

export class FivetranWorkerHttpHandler {
  private readonly client: FivetranClient;

  constructor(private readonly dependencies: Readonly<{
    oauthWorkerSigningSecret: string;
    allowedRedirectUris: ReadonlySet<string>;
    config: FivetranWorkerConfig;
    store: FivetranConnectionStore;
    destinations: FivetranDestinationStore;
    /** Present when Albert can hand a Deputy grant to Fivetran (Deputy app configured). */
    deputyCredentials?: DeputyFivetranCredentialBridge;
    /** Present when Albert's Xero OAuth app is configured (Xero via the SDK connector). */
    xeroCredentials?: NativeFivetranCredentialBridge;
    /** Present when Albert's Lightspeed R-Series OAuth app is configured (Lightspeed via the SDK connector). */
    lightspeedCredentials?: NativeFivetranCredentialBridge;
    client?: FivetranClient;
  }>) {
    if (Buffer.byteLength(dependencies.oauthWorkerSigningSecret, "utf8") < 32) {
      throw new Error("ALBERT_OAUTH_WORKER_SIGNING_SECRET must contain at least 32 UTF-8 bytes.");
    }
    this.client = dependencies.client ?? new FivetranClient({
      apiKey: dependencies.config.apiKey,
      apiSecret: dependencies.config.apiSecret,
    });
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return errorResponse("method_not_allowed", 405);
    const url = new URL(request.url);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 64 * 1024) return errorResponse("request_too_large", 413);
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > 64 * 1024) return errorResponse("request_too_large", 413);
    // The token broker is called by the Fivetran-hosted SDK connector, which
    // holds a per-connection bearer secret rather than the worker's HMAC key.
    if (url.pathname === "/v1/fivetran/token") {
      try {
        return await this.token(request, record(JSON.parse(body)));
      } catch (error) {
        console.error("Albert Fivetran token broker request failed", {
          message: error instanceof Error ? error.message : "unknown",
        });
        return publicError(error);
      }
    }
    const verified = await verifyInternalRequest({
      method: request.method,
      path: url.pathname,
      body,
      secret: this.dependencies.oauthWorkerSigningSecret,
      timestamp: request.headers.get("x-albert-timestamp"),
      signature: request.headers.get("x-albert-signature"),
      maxSkewMs: 60_000,
    }).catch(() => false);
    if (!verified) return errorResponse("unauthorised", 401);

    try {
      const input = record(JSON.parse(body));
      // /v1/fivetran/{service}/{start|callback} — service is Fivetran's
      // connector id and decides how the grant happens. Connection-scoped
      // actions (/v1/fivetran/connection/{sync|status|disconnect}) resolve
      // the service from the stored row; the legacy /v1/fivetran/xero/{sync…}
      // spellings keep working for callers already deployed.
      const match = /^\/v1\/fivetran\/([a-z][a-z0-9_]{1,63})\/(start|callback|sync|status|disconnect)$/u
        .exec(url.pathname);
      if (!match) return errorResponse("not_found", 404);
      const [, segment, action] = match as unknown as [string, string, string];
      if (action === "sync") return await this.sync(input);
      if (action === "status") return await this.status(input);
      if (action === "disconnect") return await this.disconnect(input);
      if (!isFivetranService(segment)) return errorResponse("not_found", 404);
      const definition = FIVETRAN_SERVICES[segment as FivetranService];
      return action === "start"
        ? await this.start(input, definition)
        : await this.callback(input, definition);
    } catch (error) {
      console.error("Albert Fivetran worker request failed", {
        path: url.pathname,
        errorName: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : "unknown",
        status: error instanceof FivetranApiError ? error.status : undefined,
      });
      return publicError(error);
    }
  }

  private async start(input: Record<string, unknown>, definition: FivetranServiceDefinition) {
    if (definition.authorization !== "connect_card") {
      return this.startApiAuthorised(input, definition);
    }
    const tenantId = requiredString(input, "tenantId", 26);
    const userId = requiredString(input, "userId", 36);
    const redirectUri = requiredString(input, "redirectUri", 1000);
    if (!this.dependencies.allowedRedirectUris.has(redirectUri)) {
      throw new Error("oauth_redirect_not_allowed");
    }
    const expiresAt = new Date(requiredString(input, "expiresAt", 40));
    const remaining = expiresAt.valueOf() - Date.now();
    if (!Number.isFinite(expiresAt.valueOf()) || remaining < 60_000 || remaining > 10 * 60_000 + 30_000) {
      throw new Error("oauth_expiry_invalid");
    }
    // Fivetran's Xero connector has no API authorisation path: the Connect
    // Card is the only place a grant can happen, and it renders whatever the
    // connection is missing. Without Albert's own Web-app client id + secret
    // pre-set, the card opens on the "Custom connection" tab and asks the end
    // user to type a client secret — the operator's, not theirs. Refuse to
    // hand out a card that cannot be completed by an ordinary Xero user.
    const cardConfig = this.connectCardConfig(definition);
    const previous = await this.dependencies.store.listPending({ tenantId, service: definition.service });
    for (const row of previous) {
      await this.client.deleteConnection(row.fivetranConnectionId).catch(() => undefined);
    }
    await this.dependencies.store.abandonPending({ tenantId, actorUserId: userId, service: definition.service });
    const connectionId = ulid();
    const destinationSchema = fivetranConnectionSchema(this.schemaPrefix(definition), connectionId);
    await this.dependencies.destinations.bind({
      destinationSchema,
      tenantId,
      connectionId,
      writerRole: this.dependencies.config.destinationRole,
    });
    const created = await this.client.createConnection({
      service: definition.service,
      groupId: this.dependencies.config.groupId,
      schema: destinationSchema,
      config: cardConfig,
      connectCard: { redirectUri },
    });
    if (created.schema !== destinationSchema) {
      await this.client.deleteConnection(created.id).catch(() => undefined);
      throw new Error("fivetran_schema_mismatch");
    }
    const connectCardUri = created.connectCardUri
      ?? await this.client.createConnectCard(created.id, redirectUri);
    const session = await this.dependencies.store.createPending({
      tenantId,
      connectionId,
      initiatedBy: userId,
      fivetranConnectionId: created.id,
      destinationSchema,
      service: definition.service,
      displayName: definition.displayName,
      redirectUri,
      stateNonceHash: stateNonceHash(input),
      expiresAt: expiresAt.toISOString(),
    });
    return response({
      oauthSessionId: session.oauthSessionId,
      connectionId: session.connectionId,
      connectCardUri,
    });
  }

  /**
   * API-authorised services (Deputy). Albert already holds the grant — the
   * native Deputy OAuth just completed with ingestion forced to manual — so
   * the Fivetran connection is created outright with `sub_domain` + the
   * current access token, tested, unpaused, and started. No Connect Card, no
   * pending session: the row is connected (or the call fails) before the
   * browser is redirected. Fivetran never refreshes this token, so
   * `refreshDeputyTokens()` re-pushes a fresh one on a schedule.
   */
  private async startApiAuthorised(input: Record<string, unknown>, definition: FivetranServiceDefinition) {
    if (definition.service === "deputy") return this.startDeputy(input, definition);
    const sdk = this.sdkService(definition.service);
    if (sdk) return this.startSdk(input, definition, sdk);
    throw new Error("fivetran_service_unsupported");
  }

  /** The SDK-connector shape of a service, or undefined when it is not one. */
  private sdkService(service: string): SdkServiceDefinition | undefined {
    if (service === "xero") {
      return {
        label: "Xero",
        bridge: this.dependencies.xeroCredentials,
        notConfigured: "Xero via Fivetran needs Albert's Xero OAuth app (XERO_CLIENT_ID) on the sync worker.",
        projectDir: this.dependencies.config.sdkProjectDir ?? "connectors/xero-fivetran-sdk",
        accountMissing: "fivetran_xero_tenant_missing",
        configuration: (input) => ({
          albert_token_url: input.brokerOrigin,
          albert_token_secret: input.secret,
          albert_tenant_id: input.tenantId,
          albert_connection_id: input.connectionId,
          xero_tenant_id: input.externalAccountReference,
          reports_interval_hours: "6",
        }),
      };
    }
    if (service === "light_speed_retail") {
      return {
        label: "Lightspeed R-Series",
        bridge: this.dependencies.lightspeedCredentials,
        notConfigured: "Lightspeed via Fivetran needs Albert's Lightspeed R-Series OAuth app (LIGHTSPEED_CLIENT_ID) on the sync worker.",
        projectDir: this.dependencies.config.lightspeedSdkProjectDir ?? "connectors/lightspeed-fivetran-sdk",
        accountMissing: "fivetran_lightspeed_account_missing",
        configuration: (input) => ({
          albert_token_url: input.brokerOrigin,
          albert_token_secret: input.secret,
          albert_tenant_id: input.tenantId,
          albert_connection_id: input.connectionId,
          lightspeed_account_id: input.externalAccountReference,
          include_optional: "false",
        }),
      };
    }
    return undefined;
  }

  /**
   * Deputy: Albert already holds the grant — the native Deputy OAuth just
   * completed with ingestion forced to manual — so the Fivetran connection is
   * created outright with `sub_domain` + the current access token, tested,
   * unpaused, and started. Fivetran never refreshes this token, so
   * `refreshDeputyTokens()` re-pushes a fresh one on a schedule.
   */
  private async startDeputy(input: Record<string, unknown>, definition: FivetranServiceDefinition) {
    const bridge = this.dependencies.deputyCredentials;
    if (!bridge) {
      throw new Error(
        "fivetran_not_configured:Deputy via Fivetran needs Albert's Deputy OAuth app "
        + "(DEPUTY_CLIENT_ID / DEPUTY_CLIENT_SECRET) on the sync worker.",
      );
    }
    const tenantId = requiredString(input, "tenantId", 26);
    const userId = requiredString(input, "userId", 36);
    const nativeConnectionId = requiredString(input, "nativeConnectionId", 26);
    const credential = await bridge.read({ tenantId, nativeConnectionId });

    // One Fivetran connection per Deputy install: re-running the grant for an
    // install Fivetran already syncs just refreshes its token.
    const existing = await this.dependencies.store.findByNativeConnection({ tenantId, nativeConnectionId });
    if (existing) {
      await this.client.updateConfig(existing.fivetranConnectionId, {
        sub_domain: credential.subDomain,
        access_token: credential.accessToken,
      });
      await this.dependencies.store.recordSyncState({
        tenantId,
        connectionId: existing.connectionId,
        syncState: existing.lastSyncState ?? "syncing",
        authHealth: "healthy",
        status: "connected",
      });
      return response({ connectionId: existing.connectionId, fivetranConnectionId: existing.fivetranConnectionId });
    }

    const connectionId = ulid();
    const destinationSchema = fivetranConnectionSchema(definition.schemaPrefix, connectionId);
    await this.dependencies.destinations.bind({
      destinationSchema,
      tenantId,
      connectionId,
      writerRole: this.dependencies.config.destinationRole,
    });
    const created = await this.client.createConnection({
      service: definition.service,
      groupId: this.dependencies.config.groupId,
      schema: destinationSchema,
      config: { sub_domain: credential.subDomain, access_token: credential.accessToken },
      runSetupTests: true,
      paused: false,
    });
    if (created.schema !== destinationSchema) {
      await this.client.deleteConnection(created.id).catch(() => undefined);
      throw new Error("fivetran_schema_mismatch");
    }
    let remote = created;
    if (remote.status.setupState !== "connected") {
      remote = await this.client.runSetupTests(created.id).catch(() => created);
    }
    if (remote.status.setupState !== "connected") {
      const detail = summarizeSetupTests(remote.setupTests) || "Fivetran could not reach Deputy with this grant.";
      await this.client.deleteConnection(created.id).catch(() => undefined);
      throw new Error(`fivetran_setup_incomplete:${detail}`);
    }
    try {
      await this.dependencies.store.createConnected({
        tenantId,
        connectionId,
        authorisedBy: userId,
        fivetranConnectionId: created.id,
        destinationSchema,
        service: definition.service,
        displayName: credential.displayName ? `${credential.displayName} (Fivetran)` : definition.displayName,
        nativeConnectionId,
        externalAccountReference: credential.externalAccountReference,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "fivetran_native_already_connected") {
        // A concurrent start won the unique guard: unwind this side's Fivetran
        // connection and answer with the winner so both callers converge.
        await this.client.deleteConnection(created.id).catch(() => undefined);
        await this.dependencies.destinations.retire({ destinationSchema, tenantId }).catch(() => undefined);
        await this.dependencies.destinations.purge({ destinationSchema, tenantId }).catch(() => undefined);
        const winner = await this.dependencies.store.findByNativeConnection({ tenantId, nativeConnectionId });
        if (winner) return response({ connectionId: winner.connectionId, fivetranConnectionId: winner.fivetranConnectionId });
      }
      throw error;
    }
    await this.client.unpause(created.id).catch(() => undefined);
    await this.client.enableAllSchemas(created.id).catch(() => undefined);
    await this.client.sync(created.id).catch(() => undefined);
    await this.dependencies.destinations.stamp({ destinationSchema, tenantId }).catch(() => undefined);
    return response({ connectionId, fivetranConnectionId: created.id });
  }

  /**
   * SDK services (Xero, Lightspeed R-Series): Albert's own Connector SDK
   * connector, one Fivetran connection per tenant. The native OAuth (single
   * consent) has just stored the grant with ingestion held at manual. Here
   * the worker packages the SDK project, uploads it, creates the
   * `connector_sdk` connection with a configuration that names this worker as
   * the token broker plus a fresh per-connection bearer secret (only its hash
   * is kept here), then starts the first sync. The connector never sees a
   * refresh token: on every sync it asks /v1/fivetran/token for a short-lived
   * access token.
   */
  private async startSdk(input: Record<string, unknown>, definition: FivetranServiceDefinition, sdkService: SdkServiceDefinition) {
    const bridge = sdkService.bridge;
    if (!bridge) {
      throw new Error(`fivetran_not_configured:${sdkService.notConfigured}`);
    }
    const brokerOrigin = this.dependencies.config.tokenBrokerOrigin;
    if (!brokerOrigin) {
      throw new Error(`fivetran_not_configured:FIVETRAN_TOKEN_BROKER_ORIGIN (or FLY_APP_NAME) must be set so the ${sdkService.label} connector can reach this worker.`);
    }
    const tenantId = requiredString(input, "tenantId", 26);
    const userId = requiredString(input, "userId", 36);
    const nativeConnectionId = requiredString(input, "nativeConnectionId", 26);
    // Proves the grant is live before anything is created on Fivetran.
    const credential = await bridge.read({ tenantId, nativeConnectionId });
    if (!credential.externalAccountReference) throw new Error(sdkService.accountMissing);

    const existing = await this.dependencies.store.findByNativeConnection({ tenantId, nativeConnectionId });
    if (existing) {
      // Re-consent for an org Fivetran already syncs: rotate the broker secret
      // and refresh the deployed code, nothing else.
      const secret = randomBytes(32).toString("base64url");
      const projectDirExisting = resolve(process.cwd(), sdkService.projectDir);
      const packageId = await this.client.uploadSdkPackage({ zip: packageSdkProject(projectDirExisting).bytes });
      await this.client.updateSdkPackage(existing.fivetranConnectionId, packageId).catch(() => undefined);
      await this.client.updateSdkConfiguration(existing.fivetranConnectionId, sdkService.configuration({
        brokerOrigin, secret, tenantId, connectionId: existing.connectionId, externalAccountReference: credential.externalAccountReference,
      }));
      await this.dependencies.store.recordTokenSecret({
        tenantId, connectionId: existing.connectionId, tokenSecretHash: sha256Hex(secret),
      });
      await this.dependencies.store.recordSyncState({
        tenantId, connectionId: existing.connectionId, syncState: "syncing",
        authHealth: "healthy", status: "connected",
      });
      // A fresh grant is the usual reason to be here (re-consent after the
      // vendor revoked the app); start a sync now rather than waiting for the schedule.
      await this.client.unpause(existing.fivetranConnectionId).catch(() => undefined);
      await this.client.sync(existing.fivetranConnectionId).catch(() => undefined);
      return response({ connectionId: existing.connectionId, fivetranConnectionId: existing.fivetranConnectionId });
    }

    const connectionId = ulid();
    const destinationSchema = fivetranConnectionSchema(this.schemaPrefix(definition), connectionId);
    const secret = randomBytes(32).toString("base64url");
    const configuration = sdkService.configuration({
      brokerOrigin, secret, tenantId, connectionId, externalAccountReference: credential.externalAccountReference,
    });
    const projectDir = resolve(process.cwd(), sdkService.projectDir);
    const sdk = packageSdkProject(projectDir);

    await this.dependencies.destinations.bind({
      destinationSchema, tenantId, connectionId, writerRole: this.dependencies.config.destinationRole,
    });
    // The secret hash must exist before Fivetran runs the connector's first
    // setup test, or the broker would refuse it. Row is born connected; a
    // failure below disconnects it again. The unique guard on the native
    // connection makes a concurrent duplicate start converge on the winner.
    try {
      await this.dependencies.store.createConnected({
        tenantId,
        connectionId,
        authorisedBy: userId,
        fivetranConnectionId: `pending_${connectionId}`,
        destinationSchema,
        service: definition.service,
        displayName: credential.displayName ? `${credential.displayName} (Fivetran)` : definition.displayName,
        nativeConnectionId,
        externalAccountReference: credential.externalAccountReference,
        tokenSecretHash: sha256Hex(secret),
        sdkPackageSha256: sdk.sha256,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "fivetran_native_already_connected") {
        await this.dependencies.destinations.retire({ destinationSchema, tenantId }).catch(() => undefined);
        await this.dependencies.destinations.purge({ destinationSchema, tenantId }).catch(() => undefined);
        const winner = await this.dependencies.store.findByNativeConnection({ tenantId, nativeConnectionId });
        if (winner) return response({ connectionId: winner.connectionId, fivetranConnectionId: winner.fivetranConnectionId });
      }
      throw error;
    }
    const groupId = this.dependencies.config.groupId;
    let created;
    let packageId: string | undefined;
    try {
      packageId = await this.client.uploadSdkPackage({ zip: sdk.bytes });
      created = await this.client.createSdkConnection({
        groupId,
        schema: destinationSchema,
        packageId,
        configuration,
        pythonVersion: this.dependencies.config.sdkPythonVersion ?? "3.12",
        syncFrequencyMinutes: 60,
        paused: true,
      });
    } catch (error) {
      if (packageId) await this.client.deleteSdkPackage(packageId).catch(() => undefined);
      await this.dependencies.store.markDisconnected({ tenantId, connectionId, actorUserId: userId }).catch(() => undefined);
      throw error;
    }
    if (created.schema !== destinationSchema) {
      await this.client.deleteConnection(created.id).catch(() => undefined);
      await this.dependencies.store.markDisconnected({ tenantId, connectionId, actorUserId: userId }).catch(() => undefined);
      throw new Error("fivetran_schema_mismatch");
    }
    await this.dependencies.store.attachFivetranConnectionAny({ tenantId, connectionId, fivetranConnectionId: created.id });
    if (created.status.setupState === "broken") {
      const detail = summarizeSetupTests(created.setupTests) || `Fivetran could not start the ${sdkService.label} connector.`;
      console.error("Albert Fivetran SDK setup failed", { service: definition.service, connectionId, detail });
      await this.dependencies.store.recordSyncState({
        tenantId, connectionId, syncState: "failed", authHealth: "error", status: "degraded",
      });
      throw new Error(`fivetran_setup_incomplete:${detail}`);
    }
    await this.client.unpause(created.id).catch(() => undefined);
    await this.client.sync(created.id).catch(() => undefined);
    await this.dependencies.destinations.stamp({ destinationSchema, tenantId }).catch(() => undefined);
    return response({ connectionId, fivetranConnectionId: created.id });
  }

  /**
   * Keep the analytical side current for a connection: stamp tenant_id/RLS
   * onto any tables Fivetran has created since last time, and rebuild the
   * source union views when the table set changed, so the Cube contract picks
   * the schema up without anyone touching SQL. Cheap when nothing changed.
   */
  private async maintainDestination(row: Readonly<{
    tenantId: string; connectionId: string; destinationSchema: string; service: string;
  }>): Promise<void> {
    try {
      const inventory = await this.dependencies.destinations.inventory({ destinationSchema: row.destinationSchema });
      if (inventory.length === 0) return;
      const stamped = await this.dependencies.destinations.stamp({
        destinationSchema: row.destinationSchema, tenantId: row.tenantId,
      });
      const known = await this.dependencies.store.readMaintenance({ tenantId: row.tenantId, connectionId: row.connectionId });
      if (stamped > 0 || known.unionTables !== inventory.length) {
        const prefix = FIVETRAN_SERVICES[row.service as FivetranService]?.schemaPrefix ?? row.service;
        await this.dependencies.destinations.rebuildSourceViews(prefix);
        await this.dependencies.store.recordMaintenance({
          tenantId: row.tenantId, connectionId: row.connectionId, unionTables: inventory.length,
        });
      }
    } catch (error) {
      console.error("Albert Fivetran destination maintenance failed", {
        connectionId: row.connectionId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  /**
   * Token broker for the SDK connectors (Xero, Lightspeed R-Series): bearer
   * secret → short-lived access token for the tenant's native grant, plus the
   * vendor account reference the grant covers. The secret is compared
   * against the hash stored on the Fivetran connection row in constant time;
   * a wrong secret, an unknown connection or a disconnected row all read as
   * 401 so nothing about the row leaks.
   */
  private async token(request: Request, input: Record<string, unknown>): Promise<Response> {
    const authorization = request.headers.get("authorization") ?? "";
    const presented = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const tenantId = typeof input.tenantId === "string" ? input.tenantId : "";
    const connectionId = typeof input.connectionId === "string" ? input.connectionId : "";
    if (!presented || !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(tenantId) || !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(connectionId)) {
      return errorResponse("unauthorised", 401);
    }
    const row = await this.dependencies.store.loadForTokenBroker({ tenantId, connectionId }).catch(() => null);
    if (!row || !row.tokenSecretHash || !row.nativeConnectionId) return errorResponse("unauthorised", 401);
    const expected = Buffer.from(row.tokenSecretHash, "hex");
    const actual = Buffer.from(sha256Hex(presented), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return errorResponse("unauthorised", 401);
    }
    const bridge = this.sdkService(row.service)?.bridge;
    if (!bridge) return errorResponse("not_found", 404);
    const credential = await bridge.read({ tenantId, nativeConnectionId: row.nativeConnectionId });
    await this.dependencies.store.recordSyncState({
      tenantId, connectionId, syncState: row.lastSyncState ?? "syncing", authHealth: "healthy",
    }).catch(() => undefined);
    // Each sync starts with a token call: a good moment to fold any tables the
    // previous sync created into the Cube contract. Never delays the token.
    void this.maintainDestination(row);
    return response({
      accessToken: credential.accessToken,
      expiresAt: credential.expiresAt,
      externalAccountId: credential.externalAccountReference,
      // Legacy key the deployed Xero connector reads.
      ...(row.service === "xero" ? { xeroTenantId: credential.externalAccountReference } : {}),
    });
  }

  /**
   * Token relay for Deputy: Fivetran holds a static access token that Deputy
   * expires after ~24 h. Every connected Deputy row is refreshed through the
   * vault (lease-guarded, rotation-safe) and the new token pushed to Fivetran.
   * Called from the worker's background loop; returns how many were pushed.
   */
  async refreshDeputyTokens(signal?: AbortSignal): Promise<number> {
    const bridge = this.dependencies.deputyCredentials;
    if (!bridge) return 0;
    const rows = await this.dependencies.store.listConnectedByService({ service: "deputy" });
    let pushed = 0;
    for (const row of rows) {
      if (signal?.aborted) break;
      if (!row.nativeConnectionId) continue;
      try {
        const credential = await bridge.read({
          tenantId: row.tenantId,
          nativeConnectionId: row.nativeConnectionId,
          signal,
        });
        await this.client.updateConfig(row.fivetranConnectionId, {
          sub_domain: credential.subDomain,
          access_token: credential.accessToken,
        });
        pushed += 1;
      } catch (error) {
        console.error("Albert Fivetran Deputy token relay failed", {
          tenantId: row.tenantId,
          connectionId: row.connectionId,
          message: error instanceof Error ? error.message : "unknown",
        });
        await this.dependencies.store.recordSyncState({
          tenantId: row.tenantId,
          connectionId: row.connectionId,
          syncState: row.lastSyncState ?? "failed",
          authHealth: "expired",
          status: "degraded",
        }).catch(() => undefined);
      }
    }
    return pushed;
  }

  /**
   * Destination-schema prefix per service. Xero keeps the operator override
   * (FIVETRAN_XERO_SCHEMA) it always had; the others use their fixed prefix.
   */
  private schemaPrefix(definition: FivetranServiceDefinition): string {
    return definition.service === "xero"
      ? this.dependencies.config.destinationSchema
      : definition.schemaPrefix;
  }

  /**
   * Config Fivetran needs *before* the Connect Card opens so the card asks the
   * end user for nothing but the grant. Lightspeed Retail (R-Series) is
   * authorised by Fivetran's own OAuth app; nothing to pre-fill.
   */
  private connectCardConfig(definition: FivetranServiceDefinition): Record<string, string> {
    void definition;
    return {};
  }

  private async callback(input: Record<string, unknown>, definition: FivetranServiceDefinition) {
    const session = await this.dependencies.store.loadPendingSession({
      tenantId: requiredString(input, "tenantId", 26),
      oauthSessionId: requiredString(input, "oauthSessionId", 26),
      initiatedBy: requiredString(input, "userId", 36),
      stateNonceHash: stateNonceHash(input),
    });
    if (session.service !== definition.service) throw new Error("fivetran_service_mismatch");
    const remote = await this.client.getConnection(session.fivetranConnectionId);
    if (remote.schema !== session.destinationSchema) {
      await this.client.deleteConnection(remote.id).catch(() => undefined);
      throw new Error("fivetran_schema_mismatch");
    }
    if (remote.status.setupState !== "connected") {
      const detail = summarizeSetupTests(remote.setupTests)
        || `Finish ${definition.displayName.replace(/ \(Fivetran\)$/u, "")} authorisation so Fivetran can start the sync.`;
      console.error("Albert Fivetran setup stayed incomplete", {
        service: definition.service,
        setupState: remote.status.setupState,
        tests: remote.setupTests,
      });
      throw new Error(`fivetran_setup_incomplete:${detail}`);
    }
    await this.client.unpause(remote.id);
    await this.client.enableAllSchemas(remote.id).catch(() => undefined);
    try {
      await this.client.resync(remote.id);
    } catch {
      await this.client.sync(remote.id);
    }
    await this.dependencies.store.finalizeConnected({
      tenantId: session.tenantId,
      oauthSessionId: session.oauthSessionId,
      connectionId: session.connectionId,
      initiatedBy: session.initiatedBy,
      displayName: definition.displayName,
      syncState: "syncing",
    });
    const connection = await this.dependencies.store.loadConnection({
      tenantId: session.tenantId,
      connectionId: session.connectionId,
      actorUserId: session.initiatedBy,
    });
    await this.dependencies.destinations.stamp({
      destinationSchema: connection.destinationSchema,
      tenantId: session.tenantId,
    }).catch(() => undefined);
    return response({
      status: "connected",
      oauthSessionId: session.oauthSessionId,
      connectionId: session.connectionId,
    });
  }

  private async sync(input: Record<string, unknown>) {
    const connection = await this.dependencies.store.loadConnection({
      tenantId: requiredString(input, "tenantId", 26),
      connectionId: requiredString(input, "connectionId", 26),
      actorUserId: requiredString(input, "userId", 36),
    });
    if (connection.status === "disconnected") throw new Error("fivetran_connection_not_found");
    await this.client.sync(connection.fivetranConnectionId);
    await this.dependencies.store.recordSyncState({
      tenantId: connection.tenantId,
      connectionId: connection.connectionId,
      syncState: "syncing",
    });
    await this.dependencies.destinations.stamp({
      destinationSchema: connection.destinationSchema,
      tenantId: connection.tenantId,
    }).catch(() => undefined);
    return response({
      accepted: true,
      syncRunId: connection.connectionId,
    });
  }

  /**
   * Live sync readout for the Connections card. Two sources are combined:
   * Fivetran's own view of the connection (setup/sync state, whether the
   * historical load is still running, last success/failure) and what has
   * actually landed in the tenant's destination schema (tables + ≈rows).
   * Fivetran exposes no percentage, so the closest honest progress signal
   * during the historical load is "tables landed / tables enabled". The
   * result is also written back to control_plane so the workspace tile stops
   * reading "syncing" forever after the first load finishes.
   */
  private async status(input: Record<string, unknown>) {
    const connection = await this.dependencies.store.loadConnection({
      tenantId: requiredString(input, "tenantId", 26),
      connectionId: requiredString(input, "connectionId", 26),
      actorUserId: requiredString(input, "userId", 36),
    });
    if (connection.status === "disconnected") throw new Error("fivetran_connection_not_found");
    const [remote, schema, tables] = await Promise.all([
      this.client.getConnection(connection.fivetranConnectionId),
      this.client.getSchemaSummary(connection.fivetranConnectionId).catch(
        () => ({ loaded: false, enabledTables: 0, totalTables: 0 }),
      ),
      this.dependencies.destinations.inventory({ destinationSchema: connection.destinationSchema })
        .catch(() => [] as const),
    ]);
    const landedTables = tables.filter((table) => table.rows > 0).length;
    const totalRows = tables.reduce((sum, table) => sum + table.rows, 0);
    const setupBroken = remote.status.setupState === "broken";
    const historical = remote.status.isHistoricalSync === true;
    const syncing = remote.status.syncState === "syncing";
    const phase: FivetranSyncPhase = setupBroken
      ? "broken"
      : remote.paused || remote.status.syncState === "paused"
        ? "paused"
        : historical
          ? "historical"
          : syncing
            ? "incremental"
            : remote.succeededAt
              ? "up_to_date"
              : remote.failedAt
                ? "failed"
                : "scheduled";
    // Progress only during history: landed tables over the tables Fivetran
    // says it will sync. Held below 100 until Fivetran itself says history is
    // done, because a table with zero rows is indistinguishable from one not
    // yet reached.
    const progress = phase === "historical"
      ? schema.enabledTables > 0
        ? Math.min(95, Math.round((landedTables / schema.enabledTables) * 100))
        : undefined
      : phase === "up_to_date" || phase === "incremental"
        ? 100
        : undefined;
    const persistedSyncState = phase === "up_to_date"
      ? "succeeded"
      : phase === "broken" || phase === "failed"
        ? "failed"
        : phase === "paused"
          ? "paused"
          : "syncing";
    await this.dependencies.store.recordSyncState({
      tenantId: connection.tenantId,
      connectionId: connection.connectionId,
      syncState: persistedSyncState,
      authHealth: setupBroken ? "expired" : "healthy",
      status: setupBroken ? "blocked" : phase === "failed" ? "degraded" : "connected",
    }).catch(() => undefined);
    void this.maintainDestination(connection);
    return response({
      connectionId: connection.connectionId,
      phase,
      progress,
      paused: remote.paused,
      setupState: remote.status.setupState,
      syncState: remote.status.syncState,
      succeededAt: remote.succeededAt ?? null,
      failedAt: remote.failedAt ?? null,
      warnings: [...remote.status.warnings, ...remote.status.tasks].slice(0, 6),
      schemaLoaded: schema.loaded,
      enabledTables: schema.enabledTables,
      landedTables,
      totalRows,
      tables: [...tables]
        .sort((left, right) => right.rows - left.rows || left.table.localeCompare(right.table))
        .slice(0, 60),
      checkedAt: new Date().toISOString(),
    });
  }

  private async disconnect(input: Record<string, unknown>) {
    const connection = await this.dependencies.store.loadConnection({
      tenantId: requiredString(input, "tenantId", 26),
      connectionId: requiredString(input, "connectionId", 26),
      actorUserId: requiredString(input, "userId", 36),
    });
    await this.client.deleteConnection(connection.fivetranConnectionId).catch((error) => {
      if (error instanceof FivetranApiError && error.status === 404) return;
      throw error;
    });
    await this.dependencies.store.markDisconnected({
      tenantId: connection.tenantId,
      connectionId: connection.connectionId,
      actorUserId: requiredString(input, "userId", 36),
    });
    // The schema leaves the Cube contract, then its data is erased outright:
    // disconnect means the tenant's landed rows do not linger in the
    // analytical database. Retire must commit before purge will run.
    await this.dependencies.destinations.retire({
      destinationSchema: connection.destinationSchema, tenantId: connection.tenantId,
    }).catch(() => undefined);
    await this.dependencies.destinations.rebuildSourceViews(
      FIVETRAN_SERVICES[connection.service as FivetranService]?.schemaPrefix ?? connection.service,
    ).catch(() => undefined);
    await this.dependencies.destinations.purge({
      destinationSchema: connection.destinationSchema, tenantId: connection.tenantId,
    }).catch((error) => {
      console.error("Albert Fivetran destination purge failed", {
        connectionId: connection.connectionId,
        message: error instanceof Error ? error.message : "unknown",
      });
    });
    return response({
      connectionId: connection.connectionId,
      status: "disconnected",
      // Deputy: the Albert-native connection that held the grant should be
      // disconnected too, so the credential is destroyed. The web tier owns
      // that path (it is the same disconnect every native connector uses).
      ...(connection.nativeConnectionId ? { nativeConnectionId: connection.nativeConnectionId } : {}),
    });
  }
}
