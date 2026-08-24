import { FIVETRAN_XERO_DESTINATION_SCHEMA, FIVETRAN_XERO_SERVICE } from "./schema.js";

const FIVETRAN_API_ORIGIN = "https://api.fivetran.com";

export type FivetranSetupState = "incomplete" | "connected" | "broken";
export type FivetranSyncState =
  | "scheduled"
  | "syncing"
  | "paused"
  | "rescheduled"
  | "succeeded";

export type FivetranConnectionStatus = Readonly<{
  setupState: FivetranSetupState;
  syncState: string;
  updateState?: string;
  /** True while Fivetran is still loading history for the connection. */
  isHistoricalSync?: boolean;
  /** Fivetran-side warnings/tasks the owner may need to act on (titles only). */
  warnings: readonly string[];
  tasks: readonly string[];
}>;

export type FivetranSchemaSummary = Readonly<{
  /** Fivetran has fetched the source schema at least once. */
  loaded: boolean;
  enabledTables: number;
  totalTables: number;
}>;

export type FivetranSetupTest = Readonly<{
  title: string;
  status: string;
  message?: string;
}>;

export type FivetranConnection = Readonly<{
  id: string;
  service: string;
  schema: string;
  groupId: string;
  paused: boolean;
  /** Fivetran schedule. Manual does not start a job on unpause. */
  scheduleType?: "auto" | "manual";
  status: FivetranConnectionStatus;
  setupTests: readonly FivetranSetupTest[];
  connectCardUri?: string;
  succeededAt?: string;
  failedAt?: string;
}>;

export type FivetranClientConfig = Readonly<{
  apiKey: string;
  apiSecret: string;
  fetcher?: typeof fetch;
}>;

export class FivetranApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FivetranApiError";
  }
}

function basicAuth(apiKey: string, apiSecret: string): string {
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`, "utf8").toString("base64")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FivetranApiError(`Fivetran returned an invalid ${label}.`, 502);
  }
  return value;
}

function parseSetupTests(value: unknown): readonly FivetranSetupTest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const test = asRecord(item);
    if (typeof test.title !== "string" || !test.title.trim()) return [];
    return [{
      title: test.title.replace(/[\r\n\t]+/g, " ").slice(0, 80),
      status: typeof test.status === "string" ? test.status : "UNKNOWN",
      ...(typeof test.message === "string" && test.message.trim()
        ? { message: test.message.replace(/[\r\n\t]+/g, " ").slice(0, 200) }
        : {}),
    }];
  });
}

export function summarizeSetupTests(tests: readonly FivetranSetupTest[]): string {
  const failed = tests.filter((test) => test.status !== "PASSED" && test.status !== "SKIPPED");
  const parts = (failed.length > 0 ? failed : tests).map((test) => (
    test.message ? `${test.title}: ${test.message}` : `${test.title}: ${test.status}`
  ));
  return parts.join("; ").slice(0, 280);
}

function parseConnection(payload: unknown): FivetranConnection {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const status = asRecord(data.status);
  const connectCard = asRecord(data.connect_card);
  const setupState = status.setup_state;
  if (setupState !== "incomplete" && setupState !== "connected" && setupState !== "broken") {
    throw new FivetranApiError("Fivetran returned an invalid setup state.", 502);
  }
  return {
    id: requiredString(data.id, "connection id"),
    service: requiredString(data.service, "service"),
    schema: requiredString(data.schema, "schema"),
    groupId: requiredString(data.group_id, "group id"),
    paused: data.paused === true,
    scheduleType: data.schedule_type === "manual" || data.schedule_type === "auto"
      ? data.schedule_type
      : undefined,
    status: {
      setupState,
      syncState: typeof status.sync_state === "string" ? status.sync_state : "unknown",
      updateState: typeof status.update_state === "string" ? status.update_state : undefined,
      isHistoricalSync: typeof status.is_historical_sync === "boolean" ? status.is_historical_sync : undefined,
      warnings: parseTitles(status.warnings),
      tasks: parseTitles(status.tasks),
    },
    setupTests: parseSetupTests(data.setup_tests),
    connectCardUri: typeof connectCard.uri === "string" && connectCard.uri.startsWith("https://")
      ? connectCard.uri
      : undefined,
    succeededAt: isoTimestamp(data.succeeded_at),
    failedAt: isoTimestamp(data.failed_at),
  };
}

function parseTitles(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = asRecord(item);
    // "Tables Excluded" fires on every Xero connection whose region lacks a
    // module (e.g. payroll); nothing for the owner to do, so it is not surfaced.
    if (typeof entry.code === "string" && entry.code.startsWith("tables_excluded")) return [];
    const title = typeof entry.message === "string" && entry.message.trim()
      ? entry.message
      : typeof entry.code === "string" ? entry.code : "";
    return title ? [title.replace(/[\r\n\t]+/g, " ").slice(0, 160)] : [];
  }).slice(0, 8);
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function parseSchemaSummary(payload: unknown): FivetranSchemaSummary {
  const data = asRecord(asRecord(payload).data);
  const schemas = asRecord(data.schemas);
  let enabledTables = 0;
  let totalTables = 0;
  for (const schema of Object.values(schemas)) {
    const tables = asRecord(asRecord(schema).tables);
    for (const table of Object.values(tables)) {
      totalTables += 1;
      if (asRecord(table).enabled !== false) enabledTables += 1;
    }
  }
  return { loaded: Object.keys(schemas).length > 0, enabledTables, totalTables };
}

export class FivetranClient {
  private readonly authorization: string;
  private readonly fetcher: typeof fetch;

  constructor(config: FivetranClientConfig) {
    if (!config.apiKey.trim() || !config.apiSecret.trim()) {
      throw new Error("Fivetran API credentials are required.");
    }
    this.authorization = basicAuth(config.apiKey, config.apiSecret);
    this.fetcher = config.fetcher ?? fetch;
  }

  /**
   * Create a paused connection for any Fivetran service. With `connectCard`
   * the response carries a Connect Card URI for the end user to authorise in;
   * without it (API-authorised services such as Deputy) `config` must already
   * hold the credential and `runSetupTests` decides whether Fivetran validates
   * it immediately.
   */
  async createConnection(input: Readonly<{
    service: string;
    groupId: string;
    schema: string;
    config?: Readonly<Record<string, string | boolean>>;
    connectCard?: Readonly<{ redirectUri: string }>;
    runSetupTests?: boolean;
    paused?: boolean;
    /** Start a full historical sync immediately after create. */
    isHistoricalSync?: boolean;
    /** Minutes between scheduled syncs. Stripe historical needs 1440, not 60. */
    syncFrequencyMinutes?: number;
    /** "HH:00" UTC; required by Fivetran when syncFrequencyMinutes is 1440. */
    dailySyncTimeUtc?: string;
    scheduleType?: "auto" | "manual";
  }>): Promise<FivetranConnection> {
    const syncFrequency = input.syncFrequencyMinutes ?? 60;
    return this.request("POST", "/v1/connections", {
      group_id: input.groupId,
      service: input.service,
      run_setup_tests: input.runSetupTests ?? false,
      paused: input.paused ?? true,
      sync_frequency: syncFrequency,
      schedule_type: input.scheduleType ?? "auto",
      destination_schema_names: "FIVETRAN_NAMING",
      ...(syncFrequency === 1440 && input.dailySyncTimeUtc ? { daily_sync_time: input.dailySyncTimeUtc } : {}),
      ...(input.isHistoricalSync ? { is_historical_sync: true } : {}),
      ...(input.connectCard
        ? {
          connect_card_config: {
            redirect_uri: input.connectCard.redirectUri,
            hide_setup_guide: true,
            all_fields: false,
          },
        }
        : {}),
      config: { schema: input.schema, ...(input.config ?? {}) },
    }).then(parseConnection);
  }

  async createXeroConnection(input: Readonly<{
    groupId: string;
    schema?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri: string;
  }>): Promise<FivetranConnection> {
    const config: Record<string, string> = {};
    if (input.clientId) config.client_id = input.clientId;
    if (input.clientSecret) config.client_secret = input.clientSecret;
    return this.createConnection({
      service: FIVETRAN_XERO_SERVICE,
      groupId: input.groupId,
      schema: input.schema ?? FIVETRAN_XERO_DESTINATION_SCHEMA,
      config,
      connectCard: { redirectUri: input.redirectUri },
    });
  }

  /**
   * Upload a Connector SDK code package (zip of `.py` files + an empty
   * `configuration_form.pb`) — the same call `fivetran deploy` makes:
   * `POST /v1/connector-sdk/packages`. Returns the package id that
   * `createSdkConnection` / `updateSdkPackage` reference.
   */
  async uploadSdkPackage(input: Readonly<{ zip: Uint8Array }>): Promise<string> {
    const bytes = new Uint8Array(input.zip.byteLength);
    bytes.set(input.zip);
    const form = new FormData();
    form.append("file", new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" }), "package.zip");
    const response = await this.fetcher(new URL("/v1/connector-sdk/packages", FIVETRAN_API_ORIGIN), {
      method: "POST",
      headers: { authorization: this.authorization },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    const payload = await response.json().catch(() => null);
    const record = asRecord(payload);
    if (!response.ok) {
      throw new FivetranApiError(
        typeof record.message === "string" ? record.message.slice(0, 200) : "Fivetran rejected the SDK package upload.",
        response.status,
        typeof record.code === "string" ? record.code : undefined,
      );
    }
    const id = asRecord(record.data).id;
    if (typeof id !== "string" || !id) throw new FivetranApiError("Fivetran returned no SDK package id.", 502);
    return id;
  }

  /** Delete an uploaded SDK package (cleanup after a failed create). */
  async deleteSdkPackage(packageId: string): Promise<void> {
    await this.request("DELETE", `/v1/connector-sdk/packages/${encodeURIComponent(packageId)}`).catch(() => undefined);
  }

  /**
   * Create a Connector SDK connection from an uploaded package. The
   * configuration is passed as `secrets_list` (Fivetran stores it encrypted
   * and hands it to `update(configuration)` verbatim).
   */
  async createSdkConnection(input: Readonly<{
    groupId: string;
    schema: string;
    packageId: string;
    configuration: Readonly<Record<string, string>>;
    pythonVersion?: string;
    syncFrequencyMinutes?: number;
    /** "HH:00" UTC; only meaningful with syncFrequencyMinutes 1440 (daily). */
    dailySyncTimeUtc?: string;
    paused?: boolean;
  }>): Promise<FivetranConnection> {
    return this.request("POST", "/v1/connections", {
      group_id: input.groupId,
      service: "connector_sdk",
      paused: input.paused ?? true,
      run_setup_tests: true,
      sync_frequency: input.syncFrequencyMinutes ?? 60,
      ...(input.syncFrequencyMinutes === 1440 && input.dailySyncTimeUtc ? { daily_sync_time: input.dailySyncTimeUtc } : {}),
      schedule_type: "auto",
      destination_schema_names: "FIVETRAN_NAMING",
      config: {
        schema: input.schema,
        package_id: input.packageId,
        secrets_list: Object.entries(input.configuration).map(([key, value]) => ({ key, value })),
        ...(input.pythonVersion ? { python_version: input.pythonVersion } : {}),
      },
    }).then(parseConnection);
  }

  /** Point an existing SDK connection at a newly uploaded package (code update). */
  async updateSdkPackage(connectionId: string, packageId: string): Promise<FivetranConnection> {
    return this.request("PATCH", `/v1/connections/${encodeURIComponent(connectionId)}`, {
      config: { package_id: packageId },
      run_setup_tests: false,
    }).then(parseConnection);
  }

  /** Replace an SDK connection's configuration (e.g. rotate the broker secret). */
  async updateSdkConfiguration(connectionId: string, configuration: Readonly<Record<string, string>>): Promise<FivetranConnection> {
    return this.request("PATCH", `/v1/connections/${encodeURIComponent(connectionId)}`, {
      config: { secrets_list: Object.entries(configuration).map(([key, value]) => ({ key, value })) },
      run_setup_tests: false,
    }).then(parseConnection);
  }

  /** Replace connector credentials/config in place (e.g. a rotated token). */
  async updateConfig(connectionId: string, config: Readonly<Record<string, string | boolean>>): Promise<FivetranConnection> {
    return this.request("PATCH", `/v1/connections/${encodeURIComponent(connectionId)}`, {
      config,
      run_setup_tests: false,
    }).then(parseConnection);
  }

  /** Run Fivetran's setup tests and return the refreshed connection. */
  async runSetupTests(connectionId: string): Promise<FivetranConnection> {
    return this.request("POST", `/v1/connections/${encodeURIComponent(connectionId)}/test`, {
      trust_certificates: true,
      trust_fingerprints: true,
    }).then(parseConnection);
  }

  async createConnectCard(connectionId: string, redirectUri: string): Promise<string> {
    const payload = await this.request("POST", `/v1/connections/${encodeURIComponent(connectionId)}/connect-card`, {
      connect_card_config: {
        redirect_uri: redirectUri,
        hide_setup_guide: true,
        all_fields: false,
      },
    });
    const uri = parseConnection(payload).connectCardUri;
    if (!uri) throw new FivetranApiError("Fivetran did not return a Connect Card URI.", 502);
    return uri;
  }

  async getConnection(connectionId: string): Promise<FivetranConnection> {
    return this.request("GET", `/v1/connections/${encodeURIComponent(connectionId)}`).then(parseConnection);
  }

  /**
   * Table inventory as Fivetran sees it. Before the first schema fetch
   * Fivetran answers 404 for this route; that is reported as `loaded:false`
   * rather than as an error so status polling stays quiet during setup.
   */
  async getSchemaSummary(connectionId: string): Promise<FivetranSchemaSummary> {
    try {
      const payload = await this.request("GET", `/v1/connections/${encodeURIComponent(connectionId)}/schemas`);
      return parseSchemaSummary(payload);
    } catch (error) {
      if (error instanceof FivetranApiError && error.status === 404) {
        return { loaded: false, enabledTables: 0, totalTables: 0 };
      }
      throw error;
    }
  }

  async pause(connectionId: string): Promise<FivetranConnection> {
    return this.request("PATCH", `/v1/connections/${encodeURIComponent(connectionId)}`, {
      paused: true,
    }).then(parseConnection);
  }

  async unpause(connectionId: string): Promise<FivetranConnection> {
    return this.request("PATCH", `/v1/connections/${encodeURIComponent(connectionId)}`, {
      paused: false,
    }).then(parseConnection);
  }

  /**
   * Change schedule only. Does not pause, unpause, or start a sync.
   * Use manual (or 1440) during a long Stripe historical so the hourly
   * auto schedule cannot orphan the running job.
   */
  async updateSchedule(connectionId: string, input: Readonly<{
    syncFrequencyMinutes: number;
    scheduleType?: "auto" | "manual";
    dailySyncTimeUtc?: string;
  }>): Promise<FivetranConnection> {
    return this.request("PATCH", `/v1/connections/${encodeURIComponent(connectionId)}`, {
      sync_frequency: input.syncFrequencyMinutes,
      schedule_type: input.scheduleType ?? "auto",
      ...(input.syncFrequencyMinutes === 1440 && input.dailySyncTimeUtc
        ? { daily_sync_time: input.dailySyncTimeUtc }
        : {}),
    }).then(parseConnection);
  }

  async enableAllSchemas(connectionId: string): Promise<void> {
    await this.request("PATCH", `/v1/connections/${encodeURIComponent(connectionId)}/schemas`, {
      schema_change_handling: "ALLOW_ALL",
      enable_new_by_default: true,
    });
    await this.request("POST", `/v1/connections/${encodeURIComponent(connectionId)}/schemas/reload`, {
      exclude_mode: "PRESERVE",
    });
  }

  async sync(connectionId: string): Promise<void> {
    await this.request("POST", `/v1/connections/${encodeURIComponent(connectionId)}/sync`, {
      force: true,
    });
  }

  async resync(connectionId: string): Promise<void> {
    await this.request("POST", `/v1/connections/${encodeURIComponent(connectionId)}/resync`, {});
  }

  async deleteConnection(connectionId: string): Promise<void> {
    await this.request("DELETE", `/v1/connections/${encodeURIComponent(connectionId)}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(new URL(path, FIVETRAN_API_ORIGIN), {
      method,
      headers: {
        accept: "application/json;version=2",
        authorization: this.authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const record = asRecord(payload);
      const message = typeof record.message === "string" && record.message.trim()
        ? record.message.replace(/[\r\n\t]+/g, " ").slice(0, 200)
        : "Fivetran rejected the request.";
      throw new FivetranApiError(message, response.status, typeof record.code === "string" ? record.code : undefined);
    }
    return payload;
  }
}
