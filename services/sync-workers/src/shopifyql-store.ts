import type { TransactionalPostgres } from "./database.js";
import { SHOPIFY_ADMIN_STORE_CATALOGUE_DIGEST } from "./shopify-admin-store.js";

export type ShopifyQLRuntimeBinding = Readonly<{
  tenantId: string;
  actorId: string;
  actorRole: "owner" | "manager";
  connectionId: string;
  connectionGeneration: number;
  displayName: string;
  externalAccountReference: string;
  credentialRef: string;
  approvalEvidenceDigest: string;
  appClientIdSha256: string;
}>;

export class ShopifyQLRuntimeStore {
  constructor(private readonly db: TransactionalPostgres) {}

  async ready(): Promise<void> {
    // Exact relation/column reads make a missed or partially applied migration
    // a startup/readiness failure rather than a first-user-query surprise.
    await Promise.all([
      this.db.query(
        `select ingestion_start_mode,ingestion_activated_at,
                ingestion_activated_generation,ingestion_blocked_reason
           from control_plane.connections limit 0`,
      ),
      this.db.query(
        `select tenant_id,connection_id,state
           from control_plane.readiness limit 0`,
      ),
      this.db.query(
        `select app_client_id_sha256,protected_data_level,api_version,evidence_digest,
                approved_at,expires_at,revoked_at
           from control_plane.shopify_protected_data_approvals limit 0`,
      ),
      this.db.query(
        `select tenant_id,request_id,actor_id,actor_role,conversation_id,turn_id,search_digest
           from control_plane.shopifyql_catalogue_searches limit 0`,
      ),
      this.db.query(
        `select tenant_id,request_id,connection_id,connection_generation,api_version,
                registry_sha256,query_digest,status,response_digest
           from control_plane.shopifyql_query_executions limit 0`,
      ),
    ]);
  }

  async authorizeCatalogue(input: Readonly<{
    requestId: string;
    tenantId: string;
    actorId: string;
    role: "owner" | "manager";
    conversationId: string;
    turnId: string;
    searchDigest: string;
  }>): Promise<void> {
    await this.db.transaction(async (client) => {
      const membership = await client.query<{ role: string }>(
        `select role
           from control_plane.memberships
          where tenant_id=$1 and user_id=$2::uuid and status='active'
          for share`,
        [input.tenantId, input.actorId],
      );
      if (membership.rows[0]?.role !== input.role || !["owner", "manager"].includes(input.role)) {
        throw new Error("shopifyql_actor_not_authorized");
      }
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`shopifyql-catalogue:${input.tenantId}:${input.conversationId}:${input.turnId}`],
      );
      const used = await client.query<{ total: string | number }>(
        `select count(*)::bigint as total
           from control_plane.shopifyql_catalogue_searches
          where tenant_id=$1 and conversation_id=$2 and turn_id=$3`,
        [input.tenantId, input.conversationId, input.turnId],
      );
      if (Number(used.rows[0]?.total ?? 0) >= 6) {
        throw new Error("shopifyql_catalogue_limit_exceeded");
      }
      const inserted = await client.query<{ request_id: string }>(
        `insert into control_plane.shopifyql_catalogue_searches(
           tenant_id,request_id,actor_id,actor_role,conversation_id,turn_id,search_digest
         ) values($1,$2,$3::uuid,$4,$5,$6,$7)
         on conflict (request_id) do nothing returning request_id`,
        [
          input.tenantId, input.requestId, input.actorId, input.role,
          input.conversationId, input.turnId, input.searchDigest,
        ],
      );
      if (!inserted.rows[0]) throw new Error("shopifyql_request_replayed");
    });
  }

  async reserve(input: Readonly<{
    requestId: string;
    tenantId: string;
    actorId: string;
    role: "owner" | "manager";
    conversationId: string;
    turnId: string;
    connectionId?: string;
    registrySha256: string;
    queryDigest: string;
    schema: string;
    since: string;
    until: string;
    rowLimit: number;
    appClientIdSha256: string;
  }>): Promise<ShopifyQLRuntimeBinding> {
    return this.db.transaction(async (client) => {
      const membership = await client.query<{ role: string }>(
        `select role
           from control_plane.memberships
          where tenant_id=$1 and user_id=$2::uuid and status='active'
          for share`,
        [input.tenantId, input.actorId],
      );
      if (membership.rows[0]?.role !== input.role || !["owner", "manager"].includes(input.role)) {
        throw new Error("shopifyql_actor_not_authorized");
      }
      if (input.connectionId) {
        const catalogued = await client.query<{ present: boolean }>(
          `select true as present
             from control_plane.shopify_admin_catalogue_searches
            where tenant_id=$1 and conversation_id=$2 and turn_id=$3 and search_digest=$4
            limit 1`,
          [input.tenantId, input.conversationId, input.turnId, SHOPIFY_ADMIN_STORE_CATALOGUE_DIGEST],
        );
        if (!catalogued.rows[0]) throw new Error("shopifyql_connection_selection_not_catalogued");
      }

      const approval = await client.query<{ evidence_digest: string }>(
        `select evidence_digest
           from control_plane.shopify_protected_data_approvals
          where app_client_id_sha256=$1
            and protected_data_level >= 2
            and api_version='2026-07'
            and revoked_at is null
            and (expires_at is null or expires_at > now())
          for share`,
        [input.appClientIdSha256],
      );
      const evidenceDigest = approval.rows[0]?.evidence_digest;
      if (!evidenceDigest) throw new Error("shopifyql_level2_approval_required");

      const connections = await client.query<{
        connection_id: string;
        connection_generation: string | number;
        display_name: string;
        external_account_reference: string;
        secret_reference: string;
        granted_scopes: readonly string[];
      }>(
        `select connection.connection_id,
                connection.connection_generation,
                connection.display_name,
                connection.external_account_reference,
                token.secret_reference,
                token.granted_scopes
           from control_plane.connections connection
           join control_plane.oauth_token_refs token
             on token.tenant_id=connection.tenant_id
            and token.connection_id=connection.connection_id
          where connection.tenant_id=$1
            and connection.connector_key='shopify'
            and connection.status in ('connected','degraded')
            and connection.auth_health not in ('expired','revoked')
            and connection.external_account_reference is not null
            and connection.ingestion_start_mode='manual'
            and connection.ingestion_activated_at is not null
            and connection.ingestion_activated_generation=connection.connection_generation
            and connection.ingestion_blocked_reason is null
            and not exists (
              select 1 from control_plane.readiness readiness
               where readiness.tenant_id=connection.tenant_id
                 and readiness.connection_id=connection.connection_id
                 and readiness.state='blocked'
            )
            and ($2::text is null or connection.connection_id=$2)
          order by connection.created_at
          limit 2
          for share of connection, token`,
        [input.tenantId, input.connectionId ?? null],
      );
      if (connections.rows.length === 0) throw new Error("shopifyql_connection_not_found");
      if (connections.rows.length > 1) throw new Error("shopifyql_connection_ambiguous");
      const connection = connections.rows[0]!;
      if (!connection.granted_scopes.includes("read_reports")) {
        throw new Error("shopifyql_read_reports_required");
      }

      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`shopifyql-query:${input.tenantId}:${input.conversationId}:${input.turnId}`],
      );

      const existingCount = await client.query<{ total: string | number }>(
        `select count(*)::bigint as total
           from control_plane.shopifyql_query_executions
          where tenant_id=$1 and conversation_id=$2 and turn_id=$3`,
        [input.tenantId, input.conversationId, input.turnId],
      );
      if (Number(existingCount.rows[0]?.total ?? 0) >= 6) {
        throw new Error("shopifyql_turn_limit_exceeded");
      }

      const reserved = await client.query<{ request_id: string }>(
        `insert into control_plane.shopifyql_query_executions(
           tenant_id,request_id,actor_id,actor_role,conversation_id,turn_id,
           connection_id,connection_generation,api_version,registry_sha256,
           query_digest,schema_name,since_date,until_date,row_limit,
           approval_evidence_digest,status
         ) values(
           $1,$2,$3::uuid,$4,$5,$6,$7,$8::bigint,'2026-07',$9,$10,$11,$12::date,$13::date,$14,$15,'reserved'
         ) on conflict (request_id) do nothing
         returning request_id`,
        [
          input.tenantId, input.requestId, input.actorId, input.role,
          input.conversationId, input.turnId, connection.connection_id,
          connection.connection_generation, input.registrySha256, input.queryDigest,
          input.schema, input.since, input.until, input.rowLimit, evidenceDigest,
        ],
      );
      if (!reserved.rows[0]) throw new Error("shopifyql_request_replayed");
      const generation = Number(connection.connection_generation);
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error("shopifyql_connection_generation_invalid");
      }
      return Object.freeze({
        tenantId: input.tenantId,
        actorId: input.actorId,
        actorRole: input.role,
        connectionId: connection.connection_id,
        connectionGeneration: generation,
        displayName: connection.display_name,
        externalAccountReference: connection.external_account_reference,
        credentialRef: connection.secret_reference,
        approvalEvidenceDigest: evidenceDigest,
        appClientIdSha256: input.appClientIdSha256,
      });
    });
  }

  async assertCurrent(binding: ShopifyQLRuntimeBinding): Promise<void> {
    const current = await this.db.query<{ connection_id: string }>(
      `select connection.connection_id
         from control_plane.connections connection
         join control_plane.memberships membership
           on membership.tenant_id=connection.tenant_id
          and membership.user_id=$3::uuid
          and membership.status='active'
          and membership.role=$4
        where connection.tenant_id=$1
          and connection.connection_id=$2
          and connection.connection_generation=$5::bigint
          and connection.connector_key='shopify'
          and connection.status in ('connected','degraded')
          and connection.auth_health not in ('expired','revoked')
          and connection.ingestion_start_mode='manual'
          and connection.ingestion_activated_at is not null
          and connection.ingestion_activated_generation=connection.connection_generation
          and connection.ingestion_blocked_reason is null
          and not exists (
            select 1 from control_plane.readiness readiness
             where readiness.tenant_id=connection.tenant_id
               and readiness.connection_id=connection.connection_id
               and readiness.state='blocked'
          )
          and exists (
            select 1 from control_plane.shopify_protected_data_approvals approval
             where approval.app_client_id_sha256=$6
               and approval.evidence_digest=$7
               and approval.protected_data_level >= 2
               and approval.api_version='2026-07'
               and approval.revoked_at is null
               and (approval.expires_at is null or approval.expires_at > now())
          )`,
      [
        binding.tenantId, binding.connectionId, binding.actorId,
        binding.actorRole, binding.connectionGeneration,
        binding.appClientIdSha256, binding.approvalEvidenceDigest,
      ],
    );
    if (!current.rows[0]) throw new Error("shopifyql_binding_stale");
  }

  async complete(input: Readonly<{
    requestId: string;
    binding: ShopifyQLRuntimeBinding;
    status: "succeeded" | "parse_error" | "failed" | "response_rejected";
    rowCount: number;
    responseBytes: number;
    responseDigest?: string;
    durationMs: number;
    errorCode?: string;
  }>): Promise<void> {
    const updated = await this.db.query<{ request_id: string }>(
      `update control_plane.shopifyql_query_executions execution
          set status=$5,row_count=$6,response_bytes=$7,response_digest=$8,
              duration_ms=$9,error_code=$10,completed_at=now()
        where execution.request_id=$1
          and execution.tenant_id=$2
          and execution.connection_id=$3
          and execution.connection_generation=$4::bigint
          and execution.actor_id=$11::uuid
          and execution.actor_role=$12
          and execution.status='reserved'
          -- Preserve a terminal audit when consent is revoked in flight, but
          -- never finalize a Shopify result status through a stale binding.
          and (
            $5='failed'
            or (
              exists (
                select 1 from control_plane.connections connection
                join control_plane.memberships membership
                  on membership.tenant_id=connection.tenant_id
                 and membership.user_id=$11::uuid
                 and membership.status='active'
                 and membership.role=$12
                 where connection.tenant_id=execution.tenant_id
                   and connection.connection_id=execution.connection_id
                   and connection.connection_generation=$4::bigint
                   and connection.connector_key='shopify'
                   and connection.status in ('connected','degraded')
                   and connection.auth_health not in ('expired','revoked')
                   and connection.ingestion_start_mode='manual'
                   and connection.ingestion_activated_at is not null
                   and connection.ingestion_activated_generation=connection.connection_generation
                   and connection.ingestion_blocked_reason is null
                   and not exists (
                     select 1 from control_plane.readiness readiness
                      where readiness.tenant_id=connection.tenant_id
                        and readiness.connection_id=connection.connection_id
                        and readiness.state='blocked'
                   )
               )
              and exists (
                select 1 from control_plane.shopify_protected_data_approvals approval
                 where approval.app_client_id_sha256=$13
                   and approval.evidence_digest=$14
                   and approval.protected_data_level >= 2
                   and approval.api_version='2026-07'
                   and approval.revoked_at is null
                   and (approval.expires_at is null or approval.expires_at > now())
              )
            )
          )
        returning execution.request_id`,
      [
        input.requestId, input.binding.tenantId, input.binding.connectionId,
        input.binding.connectionGeneration,
        input.status, input.rowCount, input.responseBytes, input.responseDigest ?? null,
        input.durationMs, input.errorCode ?? null,
        input.binding.actorId, input.binding.actorRole,
        input.binding.appClientIdSha256, input.binding.approvalEvidenceDigest,
      ],
    );
    if (!updated.rows[0]) throw new Error("shopifyql_binding_stale");
  }
}
