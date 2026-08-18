import { ulid } from "ulid";

import type { TransactionalPostgres } from "./database.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FIVETRAN_ID = /^[A-Za-z0-9_]{6,64}$/;
const STATE_HASH = /^[0-9a-f]{64}$/;
const SERVICE_ID = /^[a-z][a-z0-9_]{1,63}$/;

export type FivetranConnectionRow = Readonly<{
  tenantId: string;
  connectionId: string;
  fivetranConnectionId: string;
  destinationSchema: string;
  service: string;
  displayName: string;
  status: "pending" | "connected" | "degraded" | "disconnected";
  authHealth: string;
  lastSyncState: string | null;
  /** Albert-native connection whose grant Fivetran uses (Deputy). */
  nativeConnectionId?: string | null;
}>;

export type FivetranOAuthSessionRow = Readonly<{
  tenantId: string;
  oauthSessionId: string;
  connectionId: string;
  fivetranConnectionId: string;
  destinationSchema: string;
  service: string;
  initiatedBy: string;
  redirectUri: string;
  status: "pending" | "completed" | "expired";
  expiresAt: string;
}>;

function requireUlid(value: string, label: string): string {
  if (!ULID.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

type FivetranRowRecord = {
  tenant_id: string;
  connection_id: string;
  fivetran_connection_id: string;
  destination_schema: string;
  service: string;
  display_name: string;
  status: FivetranConnectionRow["status"];
  auth_health: string;
  last_sync_state: string | null;
  native_connection_id: string | null;
};

function toRow(row: FivetranRowRecord): FivetranConnectionRow {
  return {
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    fivetranConnectionId: row.fivetran_connection_id,
    destinationSchema: row.destination_schema,
    service: row.service,
    displayName: row.display_name,
    status: row.status,
    authHealth: row.auth_health,
    lastSyncState: row.last_sync_state,
    nativeConnectionId: row.native_connection_id,
  };
}

export class FivetranConnectionStore {
  constructor(private readonly db: TransactionalPostgres) {}

  async createPending(input: Readonly<{
    tenantId: string;
    connectionId: string;
    initiatedBy: string;
    fivetranConnectionId?: string;
    destinationSchema: string;
    /** Fivetran service id; defaults to xero for the original path. */
    service?: string;
    displayName?: string;
    redirectUri: string;
    stateNonceHash: string;
    expiresAt: string;
  }>): Promise<Readonly<{ connectionId: string; oauthSessionId: string }>> {
    if (!STATE_HASH.test(input.stateNonceHash)) throw new Error("oauth_state_hash_invalid");
    const service = input.service ?? "xero";
    if (!SERVICE_ID.test(service)) throw new Error("fivetran_service_invalid");
    const displayName = (input.displayName ?? "Xero (Fivetran)").slice(0, 120);
    const connectionId = requireUlid(input.connectionId, "connection_id");
    const fivetranConnectionId = input.fivetranConnectionId ?? `pending_${connectionId}`;
    if (!FIVETRAN_ID.test(fivetranConnectionId)) throw new Error("fivetran_connection_id_invalid");
    const oauthSessionId = ulid();
    await this.db.transaction(async (client) => {
      const membership = await client.query(
        `select 1
           from control_plane.memberships
          where tenant_id = $1 and user_id = $2 and status = 'active'
            and role in ('owner', 'manager')`,
        [input.tenantId, input.initiatedBy],
      );
      if (!membership.rows[0]) throw new Error("oauth_actor_not_connection_admin");
      await client.query(
        `insert into control_plane.fivetran_connections (
           tenant_id, connection_id, fivetran_connection_id, destination_schema,
           service, display_name, status, auth_health, account_metadata
         ) values (
           $1, $2, $3, $4, $5, $6, 'pending', 'unknown',
           jsonb_build_object(
             'destinationSchema', $4::text,
             'fivetranConnectionId', $3::text
           )
         )`,
        [input.tenantId, connectionId, fivetranConnectionId, input.destinationSchema, service, displayName],
      );
      await client.query(
        `insert into control_plane.fivetran_oauth_sessions (
           tenant_id, oauth_session_id, connection_id, fivetran_connection_id,
           initiated_by, redirect_uri, state_nonce_hash, status, expires_at
         ) values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
        [
          input.tenantId,
          oauthSessionId,
          connectionId,
          fivetranConnectionId,
          input.initiatedBy,
          input.redirectUri,
          input.stateNonceHash,
          input.expiresAt,
        ],
      );
      await client.query(
        `insert into control_plane.audit_log (
           tenant_id, audit_id, actor_user_id, actor_type, action,
           resource_type, resource_id, audit_metadata
         ) values ($1, $2, $3, 'service', 'fivetran.session_created',
           'fivetran_connection', $4, jsonb_build_object('service', $5::text))`,
        [input.tenantId, ulid(), input.initiatedBy, connectionId, service],
      );
    });
    return { connectionId, oauthSessionId };
  }

  async listPending(input: Readonly<{ tenantId: string; service?: string }>): Promise<readonly Readonly<{
    connectionId: string;
    fivetranConnectionId: string;
  }>[]> {
    const result = await this.db.query<{
      connection_id: string;
      fivetran_connection_id: string;
    }>(
      `select connection_id, fivetran_connection_id
         from control_plane.fivetran_connections
        where tenant_id = $1
          and status = 'pending'
          and ($2::text is null or service = $2)
          and fivetran_connection_id not like 'pending_%'`,
      [input.tenantId, input.service ?? null],
    );
    return result.rows.map((row) => ({
      connectionId: row.connection_id,
      fivetranConnectionId: row.fivetran_connection_id,
    }));
  }

  async abandonPending(input: Readonly<{
    tenantId: string;
    actorUserId: string;
    service?: string;
  }>): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        `update control_plane.fivetran_oauth_sessions as session
            set status = 'expired'
           from control_plane.fivetran_connections as connection
          where connection.tenant_id = session.tenant_id
            and connection.connection_id = session.connection_id
            and session.tenant_id = $1
            and session.status = 'pending'
            and ($2::text is null or connection.service = $2)`,
        [input.tenantId, input.service ?? null],
      );
      await client.query(
        `update control_plane.fivetran_connections
            set status = 'disconnected',
                auth_health = 'revoked',
                disconnected_at = now(),
                updated_at = now()
          where tenant_id = $1
            and status = 'pending'
            and ($2::text is null or service = $2)`,
        [input.tenantId, input.service ?? null],
      );
    });
    void input.actorUserId;
  }

  async loadPendingSession(input: Readonly<{
    tenantId: string;
    oauthSessionId: string;
    initiatedBy: string;
    stateNonceHash: string;
  }>): Promise<FivetranOAuthSessionRow> {
    requireUlid(input.oauthSessionId, "oauth_session_id");
    if (!STATE_HASH.test(input.stateNonceHash)) throw new Error("oauth_state_hash_invalid");
    const result = await this.db.query<{
      tenant_id: string;
      oauth_session_id: string;
      connection_id: string;
      fivetran_connection_id: string;
      destination_schema: string;
      service: string;
      initiated_by: string;
      redirect_uri: string;
      status: "pending" | "completed" | "expired";
      expires_at: string | Date;
    }>(
      `select session.tenant_id, session.oauth_session_id, session.connection_id,
              session.fivetran_connection_id, connection.destination_schema,
              connection.service,
              session.initiated_by, session.redirect_uri, session.status,
              session.expires_at
         from control_plane.fivetran_oauth_sessions as session
         join control_plane.fivetran_connections as connection
           on connection.tenant_id = session.tenant_id
          and connection.connection_id = session.connection_id
         join control_plane.memberships as membership
           on membership.tenant_id = session.tenant_id
          and membership.user_id = session.initiated_by
        where session.tenant_id = $1
          and session.oauth_session_id = $2
          and session.initiated_by = $3
          and session.state_nonce_hash = $4
          and session.status = 'pending'
          and session.expires_at > now()
          and membership.status = 'active'
          and membership.role in ('owner', 'manager')`,
      [input.tenantId, input.oauthSessionId, input.initiatedBy, input.stateNonceHash],
    );
    const row = result.rows[0];
    if (!row) throw new Error("oauth_session_not_found");
    return {
      tenantId: row.tenant_id,
      oauthSessionId: row.oauth_session_id,
      connectionId: row.connection_id,
      fivetranConnectionId: row.fivetran_connection_id,
      destinationSchema: row.destination_schema,
      service: row.service,
      initiatedBy: row.initiated_by,
      redirectUri: row.redirect_uri,
      status: row.status,
      expiresAt: typeof row.expires_at === "string" ? row.expires_at : row.expires_at.toISOString(),
    };
  }

  async attachFivetranConnection(input: Readonly<{
    tenantId: string;
    connectionId: string;
    fivetranConnectionId: string;
  }>): Promise<void> {
    if (!FIVETRAN_ID.test(input.fivetranConnectionId)) throw new Error("fivetran_connection_id_invalid");
    requireUlid(input.connectionId, "connection_id");
    await this.db.transaction(async (client) => {
      const updated = await client.query(
        `update control_plane.fivetran_connections
            set fivetran_connection_id = $3,
                account_metadata = jsonb_set(
                  account_metadata,
                  '{fivetranConnectionId}',
                  to_jsonb($3::text)
                ),
                updated_at = now()
          where tenant_id = $1
            and connection_id = $2
            and status = 'pending'
        returning connection_id`,
        [input.tenantId, input.connectionId, input.fivetranConnectionId],
      );
      if (!updated.rows[0]) throw new Error("fivetran_connection_not_found");
      await client.query(
        `update control_plane.fivetran_oauth_sessions
            set fivetran_connection_id = $3
          where tenant_id = $1
            and connection_id = $2
            and status = 'pending'`,
        [input.tenantId, input.connectionId, input.fivetranConnectionId],
      );
    });
  }

  async finalizeConnected(input: Readonly<{
    tenantId: string;
    oauthSessionId: string;
    connectionId: string;
    initiatedBy: string;
    displayName: string;
    syncState: string;
  }>): Promise<void> {
    await this.db.transaction(async (client) => {
      const updated = await client.query(
        `update control_plane.fivetran_connections
            set status = 'connected',
                auth_health = 'healthy',
                display_name = $4,
                authorised_by = $3,
                authorised_at = coalesce(authorised_at, now()),
                last_checked_at = now(),
                last_sync_state = $5,
                updated_at = now()
          where tenant_id = $1
            and connection_id = $2
            and status in ('pending', 'connected', 'degraded')
        returning connection_id`,
        [input.tenantId, input.connectionId, input.initiatedBy, input.displayName, input.syncState],
      );
      if (!updated.rows[0]) throw new Error("fivetran_connection_not_found");
      await client.query(
        `update control_plane.fivetran_oauth_sessions
            set status = 'completed'
          where tenant_id = $1
            and oauth_session_id = $2
            and initiated_by = $3
            and status = 'pending'`,
        [input.tenantId, input.oauthSessionId, input.initiatedBy],
      );
    });
  }

  /**
   * A connection Albert authorised itself and handed to Fivetran (Deputy).
   * There is no Connect Card session; the row is born connected.
   */
  async createConnected(input: Readonly<{
    tenantId: string;
    connectionId: string;
    authorisedBy: string;
    fivetranConnectionId: string;
    destinationSchema: string;
    service: string;
    displayName: string;
    nativeConnectionId: string;
    externalAccountReference?: string;
    /** sha256 hex of the SDK connector's broker bearer secret (Xero). */
    tokenSecretHash?: string;
    /** sha256 hex of the SDK code package deployed (Xero). */
    sdkPackageSha256?: string;
  }>): Promise<void> {
    const connectionId = requireUlid(input.connectionId, "connection_id");
    requireUlid(input.nativeConnectionId, "native_connection_id");
    if (!SERVICE_ID.test(input.service)) throw new Error("fivetran_service_invalid");
    if (!FIVETRAN_ID.test(input.fivetranConnectionId)) throw new Error("fivetran_connection_id_invalid");
    if (input.tokenSecretHash && !STATE_HASH.test(input.tokenSecretHash)) throw new Error("token_secret_hash_invalid");
    await this.db.transaction(async (client) => {
      const membership = await client.query(
        `select 1
           from control_plane.memberships
          where tenant_id = $1 and user_id = $2 and status = 'active'
            and role in ('owner', 'manager')`,
        [input.tenantId, input.authorisedBy],
      );
      if (!membership.rows[0]) throw new Error("oauth_actor_not_connection_admin");
      try {
        await client.query(
          `insert into control_plane.fivetran_connections (
             tenant_id, connection_id, fivetran_connection_id, destination_schema,
             service, display_name, status, auth_health, account_metadata,
             authorised_by, authorised_at, last_checked_at, last_sync_state
           ) values (
             $1, $2, $3, $4, $5, $6, 'connected', 'healthy',
             jsonb_strip_nulls(jsonb_build_object(
               'destinationSchema', $4::text,
               'fivetranConnectionId', $3::text,
               'nativeConnectionId', $7::text,
               'externalAccountReference', $8::text,
               'tokenSecretHash', $10::text,
               'sdkPackageSha256', $11::text
             )),
             $9, now(), now(), 'syncing'
           )`,
          [
            input.tenantId,
            connectionId,
            input.fivetranConnectionId,
            input.destinationSchema,
            input.service,
            input.displayName.slice(0, 120),
            input.nativeConnectionId,
            input.externalAccountReference ?? null,
            input.authorisedBy,
            input.tokenSecretHash ?? null,
            input.sdkPackageSha256 ?? null,
          ],
        );
      } catch (error) {
        // fivetran_connections_native_live_unique: a concurrent start already
        // connected this native grant. The caller unwinds its Fivetran-side
        // connection and returns the surviving row.
        if ((error as { code?: string })?.code === "23505") {
          throw new Error("fivetran_native_already_connected");
        }
        throw error;
      }
      await client.query(
        `insert into control_plane.audit_log (
           tenant_id, audit_id, actor_user_id, actor_type, action,
           resource_type, resource_id, audit_metadata
         ) values ($1, $2, $3, 'user', 'fivetran.connection_authorised',
           'fivetran_connection', $4, jsonb_build_object('service', $5::text, 'nativeConnectionId', $6::text))`,
        [input.tenantId, ulid(), input.authorisedBy, connectionId, input.service, input.nativeConnectionId],
      );
    });
  }

  /** Analytical maintenance markers kept on the row (union view table count). */
  async readMaintenance(input: Readonly<{ tenantId: string; connectionId: string }>): Promise<{ unionTables: number | null }> {
    const result = await this.db.query<{ union_tables: string | number | null }>(
      `select account_metadata ->> 'unionTables' as union_tables
         from control_plane.fivetran_connections
        where tenant_id = $1 and connection_id = $2`,
      [input.tenantId, requireUlid(input.connectionId, "connection_id")],
    );
    const raw = result.rows[0]?.union_tables;
    return { unionTables: raw === null || raw === undefined ? null : Number(raw) };
  }

  async recordMaintenance(input: Readonly<{ tenantId: string; connectionId: string; unionTables: number }>): Promise<void> {
    await this.db.query(
      `update control_plane.fivetran_connections
          set account_metadata = jsonb_set(account_metadata, '{unionTables}', to_jsonb($3::int)),
              updated_at = now()
        where tenant_id = $1 and connection_id = $2`,
      [input.tenantId, requireUlid(input.connectionId, "connection_id"), input.unionTables],
    );
  }

  /** Rotate the SDK connector's broker secret hash (Xero re-consent). */
  async recordTokenSecret(input: Readonly<{ tenantId: string; connectionId: string; tokenSecretHash: string }>): Promise<void> {
    if (!STATE_HASH.test(input.tokenSecretHash)) throw new Error("token_secret_hash_invalid");
    await this.db.query(
      `update control_plane.fivetran_connections
          set account_metadata = jsonb_set(account_metadata, '{tokenSecretHash}', to_jsonb($3::text)),
              updated_at = now()
        where tenant_id = $1 and connection_id = $2`,
      [input.tenantId, requireUlid(input.connectionId, "connection_id"), input.tokenSecretHash],
    );
  }

  /** Attach the Fivetran id to a row born connected (SDK connections have no pending session). */
  async attachFivetranConnectionAny(input: Readonly<{ tenantId: string; connectionId: string; fivetranConnectionId: string }>): Promise<void> {
    if (!FIVETRAN_ID.test(input.fivetranConnectionId)) throw new Error("fivetran_connection_id_invalid");
    const updated = await this.db.query(
      `update control_plane.fivetran_connections
          set fivetran_connection_id = $3,
              account_metadata = jsonb_set(account_metadata, '{fivetranConnectionId}', to_jsonb($3::text)),
              updated_at = now()
        where tenant_id = $1 and connection_id = $2 and status <> 'disconnected'
      returning connection_id`,
      [input.tenantId, requireUlid(input.connectionId, "connection_id"), input.fivetranConnectionId],
    );
    if (!updated.rows[0]) throw new Error("fivetran_connection_not_found");
  }

  /** Row lookup for the token broker: no membership (the caller is Fivetran, not a user). */
  async loadForTokenBroker(input: Readonly<{ tenantId: string; connectionId: string }>): Promise<
    (FivetranConnectionRow & Readonly<{ tokenSecretHash: string | null }>) | null
  > {
    const result = await this.db.query<FivetranRowRecord & { token_secret_hash: string | null }>(
      `select tenant_id, connection_id, fivetran_connection_id, destination_schema,
              service, display_name, status, auth_health, last_sync_state,
              account_metadata ->> 'nativeConnectionId' as native_connection_id,
              account_metadata ->> 'tokenSecretHash' as token_secret_hash
         from control_plane.fivetran_connections
        where tenant_id = $1
          and connection_id = $2
          and status in ('connected', 'degraded', 'blocked')`,
      [input.tenantId, requireUlid(input.connectionId, "connection_id")],
    );
    const row = result.rows[0];
    return row ? { ...toRow(row), tokenSecretHash: row.token_secret_hash } : null;
  }

  async findByNativeConnection(input: Readonly<{
    tenantId: string;
    nativeConnectionId: string;
  }>): Promise<FivetranConnectionRow | null> {
    requireUlid(input.nativeConnectionId, "native_connection_id");
    const result = await this.db.query<FivetranRowRecord>(
      `select tenant_id, connection_id, fivetran_connection_id, destination_schema,
              service, display_name, status, auth_health, last_sync_state,
              account_metadata ->> 'nativeConnectionId' as native_connection_id
         from control_plane.fivetran_connections
        where tenant_id = $1
          and account_metadata ->> 'nativeConnectionId' = $2
          and status in ('connected', 'degraded', 'blocked')
        order by created_at desc
        limit 1`,
      [input.tenantId, input.nativeConnectionId],
    );
    const row = result.rows[0];
    return row ? toRow(row) : null;
  }

  /** Every live connection for a service across tenants (background relays). */
  async listConnectedByService(input: Readonly<{ service: string }>): Promise<readonly FivetranConnectionRow[]> {
    if (!SERVICE_ID.test(input.service)) throw new Error("fivetran_service_invalid");
    const result = await this.db.query<FivetranRowRecord>(
      `select tenant_id, connection_id, fivetran_connection_id, destination_schema,
              service, display_name, status, auth_health, last_sync_state,
              account_metadata ->> 'nativeConnectionId' as native_connection_id
         from control_plane.fivetran_connections
        where service = $1
          and status in ('connected', 'degraded', 'blocked')
        order by created_at
        limit 1000`,
      [input.service],
    );
    return result.rows.map(toRow);
  }

  async loadConnection(input: Readonly<{
    tenantId: string;
    connectionId: string;
    actorUserId: string;
  }>): Promise<FivetranConnectionRow> {
    requireUlid(input.connectionId, "connection_id");
    const result = await this.db.query<{
      tenant_id: string;
      connection_id: string;
      fivetran_connection_id: string;
      destination_schema: string;
      service: string;
      display_name: string;
      status: FivetranConnectionRow["status"];
      auth_health: string;
      last_sync_state: string | null;
      native_connection_id: string | null;
    }>(
      `select connection.tenant_id, connection.connection_id,
              connection.fivetran_connection_id, connection.destination_schema,
              connection.service,
              connection.display_name, connection.status, connection.auth_health,
              connection.last_sync_state,
              connection.account_metadata ->> 'nativeConnectionId' as native_connection_id
         from control_plane.fivetran_connections as connection
         join control_plane.memberships as membership
           on membership.tenant_id = connection.tenant_id
          and membership.user_id = $3
        where connection.tenant_id = $1
          and connection.connection_id = $2
          and membership.status = 'active'
          and membership.role in ('owner', 'manager')`,
      [input.tenantId, input.connectionId, input.actorUserId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("fivetran_connection_not_found");
    return {
      tenantId: row.tenant_id,
      connectionId: row.connection_id,
      fivetranConnectionId: row.fivetran_connection_id,
      destinationSchema: row.destination_schema,
      service: row.service,
      displayName: row.display_name,
      status: row.status,
      authHealth: row.auth_health,
      lastSyncState: row.last_sync_state,
      nativeConnectionId: row.native_connection_id,
    };
  }

  async markDisconnected(input: Readonly<{
    tenantId: string;
    connectionId: string;
    actorUserId: string;
  }>): Promise<void> {
    await this.db.query(
      `update control_plane.fivetran_connections
          set status = 'disconnected',
              auth_health = 'revoked',
              disconnected_at = now(),
              updated_at = now()
        where tenant_id = $1
          and connection_id = $2
          and status <> 'disconnected'`,
      [input.tenantId, input.connectionId],
    );
    await this.db.query(
      `insert into control_plane.audit_log (
         tenant_id, audit_id, actor_user_id, actor_type, action,
         resource_type, resource_id, audit_metadata
       ) values ($1, $2, $3, 'user', 'fivetran.disconnected',
         'fivetran_connection', $4, jsonb_build_object('service', (
           select service from control_plane.fivetran_connections
            where tenant_id = $1 and connection_id = $4
         )))`,
      [input.tenantId, ulid(), input.actorUserId, input.connectionId],
    );
  }

  async recordSyncState(input: Readonly<{
    tenantId: string;
    connectionId: string;
    syncState: string;
    /** Optional reconciliation from Fivetran's own status; omitted = unchanged. */
    authHealth?: "healthy" | "expired" | "error";
    status?: "connected" | "degraded" | "blocked";
  }>): Promise<void> {
    await this.db.query(
      `update control_plane.fivetran_connections
          set last_sync_state = $3,
              auth_health = coalesce($4, auth_health),
              status = coalesce($5, status),
              last_checked_at = now(),
              updated_at = now()
        where tenant_id = $1
          and connection_id = $2
          and status <> 'disconnected'`,
      [input.tenantId, input.connectionId, input.syncState, input.authHealth ?? null, input.status ?? null],
    );
  }
}
