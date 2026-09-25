import { createHash } from "node:crypto";

import {
  SHOPIFY_ADMIN_MAX_CATALOGUE_SEARCHES_PER_TURN,
  SHOPIFY_ADMIN_MAX_QUERIES_PER_TURN,
} from "../../../packages/shopify-admin/src/contract.js";
import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "./database.js";

export const SHOPIFY_ADMIN_STORE_CATALOGUE_DIGEST = createHash("sha256")
  .update("shopify-admin-store-catalogue-v1")
  .digest("hex");

export type ShopifyAdminStoreChoice = Readonly<{
  connectionId: string;
  connectionGeneration: number;
  displayName: string;
}>;

export type ShopifyAdminRuntimeBinding = Readonly<{
  tenantId: string;
  actorId: string;
  actorRole: "owner" | "manager";
  connectionId: string;
  connectionGeneration: number;
  displayName: string;
  externalAccountReference: string;
  credentialRef: string;
  requiresLevel2: boolean;
  approvalEvidenceDigest: string | null;
  appClientIdSha256: string;
}>;

export class ShopifyAdminRuntimeStore {
  constructor(private readonly db: TransactionalPostgres) {}

  async ready(): Promise<void> {
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
        `select tenant_id,request_id,actor_id,actor_role,conversation_id,turn_id,search_digest
           from control_plane.shopify_admin_catalogue_searches limit 0`,
      ),
      this.db.query(
        `select tenant_id,request_id,connection_id,connection_generation,api_version,
                registry_sha256,query_digest,root_field,required_scopes,requires_level2,
                approval_evidence_digest,status,response_digest,scope_evidence_digest
           from control_plane.shopify_admin_query_executions limit 0`,
      ),
      this.db.query(
        `select app_client_id_sha256,protected_data_level,api_version,evidence_digest,
                approved_at,expires_at,revoked_at
           from control_plane.shopify_protected_data_approvals limit 0`,
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
      await this.assertMembership(client, input.tenantId, input.actorId, input.role);
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`shopify-admin-catalogue:${input.tenantId}:${input.conversationId}:${input.turnId}`],
      );
      const used = await client.query<{ total: string | number }>(
        `select count(*)::bigint as total
           from control_plane.shopify_admin_catalogue_searches
          where tenant_id=$1 and conversation_id=$2 and turn_id=$3`,
        [input.tenantId, input.conversationId, input.turnId],
      );
      if (Number(used.rows[0]?.total ?? 0) >= SHOPIFY_ADMIN_MAX_CATALOGUE_SEARCHES_PER_TURN) {
        throw new Error("shopify_admin_catalogue_limit_exceeded");
      }
      const inserted = await client.query<{ request_id: string }>(
        `insert into control_plane.shopify_admin_catalogue_searches(
           tenant_id,request_id,actor_id,actor_role,conversation_id,turn_id,search_digest
         ) values($1,$2,$3::uuid,$4,$5,$6,$7)
         on conflict (request_id) do nothing returning request_id`,
        [input.tenantId, input.requestId, input.actorId, input.role, input.conversationId, input.turnId, input.searchDigest],
      );
      if (!inserted.rows[0]) throw new Error("shopify_admin_request_replayed");
    });
  }

  /**
   * Returns only tenant-bound connection metadata needed for model-side store
   * disambiguation. Shop domains, credential references and vendor identifiers
   * never cross this boundary. The catalogue receipt is later required when a
   * model supplies an explicit connection ID.
   */
  async listConnections(input: Readonly<{
    requestId: string;
    tenantId: string;
    actorId: string;
    role: "owner" | "manager";
    conversationId: string;
    turnId: string;
  }>): Promise<readonly ShopifyAdminStoreChoice[]> {
    await this.authorizeCatalogue({
      ...input,
      searchDigest: SHOPIFY_ADMIN_STORE_CATALOGUE_DIGEST,
    });
    const result = await this.db.query<{
      connection_id: string;
      connection_generation: string | number;
      display_name: string;
    }>(
      `select connection.connection_id,connection.connection_generation,connection.display_name
         from control_plane.connections connection
         join control_plane.memberships membership
           on membership.tenant_id=connection.tenant_id
          and membership.user_id=$2::uuid and membership.status='active' and membership.role=$3
        where connection.tenant_id=$1 and connection.connector_key='shopify'
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
        order by connection.created_at,connection.connection_id
        limit 50`,
      [input.tenantId, input.actorId, input.role],
    );
    return Object.freeze(result.rows.map((row) => {
      const connectionGeneration = Number(row.connection_generation);
      if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1) {
        throw new Error("shopify_admin_connection_generation_invalid");
      }
      return Object.freeze({
        connectionId: row.connection_id,
        connectionGeneration,
        displayName: row.display_name,
      });
    }));
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
    rootField: string;
    selectedFieldCount: number;
    requiredScopes: readonly string[];
    requiredScopeGroups: readonly (readonly string[])[];
    requiresLevel2: boolean;
    appClientIdSha256: string;
  }>): Promise<ShopifyAdminRuntimeBinding> {
    return this.db.transaction(async (client) => {
      await this.assertMembership(client, input.tenantId, input.actorId, input.role);
      if (input.connectionId) {
        const catalogued = await client.query<{ present: boolean }>(
          `select true as present
             from control_plane.shopify_admin_catalogue_searches
            where tenant_id=$1 and conversation_id=$2 and turn_id=$3 and search_digest=$4
            limit 1`,
          [input.tenantId, input.conversationId, input.turnId, SHOPIFY_ADMIN_STORE_CATALOGUE_DIGEST],
        );
        if (!catalogued.rows[0]) throw new Error("shopify_admin_connection_selection_not_catalogued");
      }
      let approvalEvidenceDigest: string | null = null;
      if (input.requiresLevel2) {
        const approval = await client.query<{ evidence_digest: string }>(
          `select evidence_digest
             from control_plane.shopify_protected_data_approvals
            where app_client_id_sha256=$1
              and protected_data_level >= 2 and api_version='2026-07'
              and revoked_at is null and (expires_at is null or expires_at > now())
            for share`,
          [input.appClientIdSha256],
        );
        approvalEvidenceDigest = approval.rows[0]?.evidence_digest ?? null;
        if (!approvalEvidenceDigest) throw new Error("shopify_admin_level2_approval_required");
      }

      const connections = await client.query<{
        connection_id: string;
        connection_generation: string | number;
        display_name: string;
        external_account_reference: string;
        secret_reference: string;
        granted_scopes: readonly string[];
      }>(
        `select connection.connection_id,connection.connection_generation,
                connection.display_name,connection.external_account_reference,
                token.secret_reference,token.granted_scopes
           from control_plane.connections connection
           join control_plane.oauth_token_refs token
             on token.tenant_id=connection.tenant_id and token.connection_id=connection.connection_id
          where connection.tenant_id=$1 and connection.connector_key='shopify'
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
          order by connection.created_at limit 2
          for share of connection,token`,
        [input.tenantId, input.connectionId ?? null],
      );
      if (connections.rows.length === 0) throw new Error("shopify_admin_connection_not_found");
      if (connections.rows.length > 1) throw new Error("shopify_admin_connection_ambiguous");
      const connection = connections.rows[0]!;
      const granted = new Set(connection.granted_scopes);
      const missing = input.requiredScopeGroups.filter((group) => !group.some((scope) => granted.has(scope)));
      if (missing.length > 0) throw new Error("shopify_admin_required_scope_missing");

      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`shopify-admin-query:${input.tenantId}:${input.conversationId}:${input.turnId}`],
      );
      const used = await client.query<{ total: string | number }>(
        `select count(*)::bigint as total
           from control_plane.shopify_admin_query_executions
          where tenant_id=$1 and conversation_id=$2 and turn_id=$3`,
        [input.tenantId, input.conversationId, input.turnId],
      );
      if (Number(used.rows[0]?.total ?? 0) >= SHOPIFY_ADMIN_MAX_QUERIES_PER_TURN) {
        throw new Error("shopify_admin_turn_limit_exceeded");
      }
      const generation = Number(connection.connection_generation);
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("shopify_admin_connection_generation_invalid");
      const inserted = await client.query<{ request_id: string }>(
        `insert into control_plane.shopify_admin_query_executions(
           tenant_id,request_id,actor_id,actor_role,conversation_id,turn_id,
           connection_id,connection_generation,api_version,registry_sha256,
           query_digest,root_field,selected_field_count,required_scopes,
           requires_level2,approval_evidence_digest,status
         ) values($1,$2,$3::uuid,$4,$5,$6,$7,$8::bigint,'2026-07',$9,$10,$11,$12,$13::text[],$14,$15,'reserved')
         on conflict (request_id) do nothing returning request_id`,
        [
          input.tenantId, input.requestId, input.actorId, input.role,
          input.conversationId, input.turnId, connection.connection_id, generation,
          input.registrySha256, input.queryDigest, input.rootField,
          input.selectedFieldCount, [...input.requiredScopes], input.requiresLevel2,
          approvalEvidenceDigest,
        ],
      );
      if (!inserted.rows[0]) throw new Error("shopify_admin_request_replayed");
      return Object.freeze({
        tenantId: input.tenantId,
        actorId: input.actorId,
        actorRole: input.role,
        connectionId: connection.connection_id,
        connectionGeneration: generation,
        displayName: connection.display_name,
        externalAccountReference: connection.external_account_reference,
        credentialRef: connection.secret_reference,
        requiresLevel2: input.requiresLevel2,
        approvalEvidenceDigest,
        appClientIdSha256: input.appClientIdSha256,
      });
    });
  }

  async assertCurrent(binding: ShopifyAdminRuntimeBinding): Promise<void> {
    const rows = await this.db.query<{ connection_id: string }>(
      `select connection.connection_id
         from control_plane.connections connection
         join control_plane.memberships membership
           on membership.tenant_id=connection.tenant_id
          and membership.user_id=$3::uuid and membership.status='active' and membership.role=$4
        where connection.tenant_id=$1 and connection.connection_id=$2
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
          and (
            not $6::boolean
            or exists (
              select 1 from control_plane.shopify_protected_data_approvals approval
               where approval.app_client_id_sha256=$7
                 and approval.evidence_digest=$8
                 and approval.protected_data_level >= 2 and approval.api_version='2026-07'
                 and approval.revoked_at is null
                 and (approval.expires_at is null or approval.expires_at > now())
            )
          )`,
      [
        binding.tenantId, binding.connectionId, binding.actorId, binding.actorRole,
        binding.connectionGeneration, binding.requiresLevel2, binding.appClientIdSha256,
        binding.approvalEvidenceDigest,
      ],
    );
    if (!rows.rows[0]) throw new Error("shopify_admin_binding_stale");
  }

  async complete(input: Readonly<{
    requestId: string;
    binding: ShopifyAdminRuntimeBinding;
    status: "succeeded" | "failed" | "response_rejected";
    resultLeafCount: number;
    responseBytes: number;
    responseDigest?: string;
    scopeEvidenceDigest?: string;
    durationMs: number;
    errorCode?: string;
  }>): Promise<void> {
    const updated = await this.db.query<{ request_id: string }>(
      `update control_plane.shopify_admin_query_executions execution
          set status=$10,result_leaf_count=$11,response_bytes=$12,response_digest=$13,
              scope_evidence_digest=$14,duration_ms=$15,error_code=$16,completed_at=now()
        where execution.request_id=$1 and execution.tenant_id=$2
          and execution.connection_id=$3 and execution.connection_generation=$4::bigint
          and execution.actor_id=$5::uuid and execution.actor_role=$6
          and execution.status='reserved'
          -- A stale binding may close only as a code-only failure. Any status
          -- that could attest to or describe a merchant response must still
          -- satisfy the complete live activation/authorization predicate.
          and (
            $10='failed'
            or (
              exists (
                select 1 from control_plane.connections connection
                join control_plane.memberships membership
                  on membership.tenant_id=connection.tenant_id
                 and membership.user_id=$5::uuid and membership.status='active' and membership.role=$6
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
              and (
                not $7::boolean
                or exists (
                  select 1 from control_plane.shopify_protected_data_approvals approval
                   where approval.app_client_id_sha256=$8
                     and approval.evidence_digest=$9
                     and approval.protected_data_level >= 2 and approval.api_version='2026-07'
                     and approval.revoked_at is null
                     and (approval.expires_at is null or approval.expires_at > now())
                )
              )
            )
          )
        returning execution.request_id`,
      [
        input.requestId, input.binding.tenantId, input.binding.connectionId,
        input.binding.connectionGeneration, input.binding.actorId, input.binding.actorRole,
        input.binding.requiresLevel2, input.binding.appClientIdSha256,
        input.binding.approvalEvidenceDigest, input.status, input.resultLeafCount,
        input.responseBytes, input.responseDigest ?? null, input.scopeEvidenceDigest ?? null,
        input.durationMs, input.errorCode ?? null,
      ],
    );
    if (!updated.rows[0]) throw new Error("shopify_admin_binding_stale");
  }

  private async assertMembership(
    client: PostgresQueryClient,
    tenantId: string,
    actorId: string,
    role: "owner" | "manager",
  ): Promise<void> {
    const membership = await client.query<{ role: string }>(
      `select role from control_plane.memberships
        where tenant_id=$1 and user_id=$2::uuid and status='active' for share`,
      [tenantId, actorId],
    );
    if (membership.rows[0]?.role !== role) throw new Error("shopify_admin_actor_not_authorized");
  }
}
