import { createHash } from "node:crypto";
import { ulid } from "ulid";
import {
  applyWorkspacePatchV2,
  queryWorkspaceV2Schema,
  type EvidenceArtifactStoreV2,
  type ExecutedWorkspaceV2,
  type QueryWorkspaceV2,
  type WorkspacePatchV2,
} from "../../../packages/analytics-v2/src/index.js";
import type { CompiledWorkspaceV2 } from "../../../packages/compiler/src/v2.js";
import {
  semanticRegistryV2Digest,
  semanticRegistryDocumentV2Schema,
  validateSemanticRegistryV2,
  type SemanticRegistryDocumentV2,
} from "../../../packages/semantic-registry/src/v2.js";
import type { PgClientLike, PgPoolLike } from "./database.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const semanticRegistryCacheV2 = new Map<string, SemanticRegistryDocumentV2>();

function cacheSemanticRegistryV2(
  publicationHash: string,
  registry: SemanticRegistryDocumentV2,
): void {
  semanticRegistryCacheV2.delete(publicationHash);
  semanticRegistryCacheV2.set(publicationHash, registry);
  while (semanticRegistryCacheV2.size > 8)
    semanticRegistryCacheV2.delete(
      semanticRegistryCacheV2.keys().next().value!,
    );
}

export async function beginSemanticV2Tenant(
  client: PgClientLike,
  tenantId: string,
  readOnly = false,
): Promise<void> {
  await client.query(readOnly ? "BEGIN TRANSACTION READ ONLY" : "BEGIN");
  await client.query("SET LOCAL ROLE albert_semantic_control");
  await client.query("SELECT set_config('albert.tenant_id',$1,true)", [
    tenantId,
  ]);
}

export function analyticalRuntimeRouteV2(
  source: Readonly<Record<string, string | undefined>> = process.env,
): "v1" | "v2" {
  const route = source.ALBERT_ANALYTICAL_RUNTIME?.trim() || "v1";
  if (route !== "v1" && route !== "v2")
    throw new Error("ALBERT_ANALYTICAL_RUNTIME must be v1 or v2.");
  return route;
}

export async function loadActiveSemanticRegistryV2(
  pool: PgPoolLike,
): Promise<
  Readonly<{ publicationHash: string; registry: SemanticRegistryDocumentV2 }>
> {
  return loadSemanticRegistryV2(pool);
}

export async function loadSemanticRegistryV2(
  pool: PgPoolLike,
  publicationHash?: string,
): Promise<
  Readonly<{ publicationHash: string; registry: SemanticRegistryDocumentV2 }>
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL ROLE albert_semantic_control");
    const resolvedPublicationHash =
      publicationHash ??
      String(
        (
          await client.query(
            `SELECT publication_hash
         FROM control_plane.semantic_v2_active_publication
        WHERE singleton`,
          )
        ).rows[0]?.publication_hash ?? "",
      );
    if (!resolvedPublicationHash)
      throw new Error("No active Semantic Registry V2 publication exists.");
    const cached = semanticRegistryCacheV2.get(resolvedPublicationHash);
    if (cached) {
      await client.query("COMMIT");
      return Object.freeze({
        publicationHash: resolvedPublicationHash,
        registry: cached,
      });
    }
    const result = await client.query(
      `SELECT publication_hash,artifact->'manifest' AS manifest
         FROM control_plane.semantic_v2_publications WHERE publication_hash=$1`,
      [resolvedPublicationHash],
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row || typeof row.publication_hash !== "string")
      throw new Error(
        `Semantic Registry V2 publication ${resolvedPublicationHash} does not exist.`,
      );
    const registry = semanticRegistryDocumentV2Schema.parse(row.manifest);
    if (semanticRegistryV2Digest(registry) !== row.publication_hash)
      throw new Error(
        `Semantic Registry V2 publication ${row.publication_hash} failed its content-addressed digest check.`,
      );
    const issues = validateSemanticRegistryV2(registry);
    if (issues.length)
      throw new Error(
        `Semantic Registry V2 publication ${row.publication_hash} failed runtime validation: ${issues
          .slice(0, 12)
          .map(({ code, objectId }) => `${code}:${objectId}`)
          .join(", ")}.`,
      );
    cacheSemanticRegistryV2(row.publication_hash, registry);
    return Object.freeze({ publicationHash: row.publication_hash, registry });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* preserve original error */
    }
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresQueryWorkspaceStoreV2 {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(
    input: Readonly<{
      tenantId: string;
      questionId: string;
      publicationHash: string;
      overlayVersion: string;
      blocks: QueryWorkspaceV2["blocks"];
      derivedFrom?: Readonly<{ workspaceId: string; revision: number }>;
    }>,
  ): Promise<QueryWorkspaceV2> {
    const now = this.clock().toISOString();
    const workspace = queryWorkspaceV2Schema.parse({
      id: ulid(),
      tenantId: input.tenantId,
      questionId: input.questionId,
      publicationHash: input.publicationHash,
      overlayVersion: input.overlayVersion,
      ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}),
      revision: 1,
      blocks: input.blocks,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    const client = await this.pool.connect();
    try {
      await beginSemanticV2Tenant(client, input.tenantId);
      await client.query(
        `INSERT INTO control_plane.query_workspaces_v2(
           tenant_id,workspace_id,question_id,publication_hash,overlay_version,
           revision,status,blocks,created_by_service,created_at,updated_at,
           derived_from_workspace_id,derived_from_revision
         ) VALUES ($1,$2,$3,$4,$5,1,'draft',$6::jsonb,'semantic-query-v2',$7,$7,$8,$9)`,
        [
          input.tenantId,
          workspace.id,
          input.questionId,
          input.publicationHash,
          input.overlayVersion,
          JSON.stringify(workspace.blocks),
          now,
          input.derivedFrom?.workspaceId ?? null,
          input.derivedFrom?.revision ?? null,
        ],
      );
      await client.query(
        `INSERT INTO control_plane.query_workspace_revisions_v2(
           tenant_id,workspace_id,revision,status,blocks,workspace_hash,mutation,created_at
         ) VALUES ($1,$2,1,'draft',$3::jsonb,$4,$5::jsonb,$6)`,
        [
          input.tenantId,
          workspace.id,
          JSON.stringify(workspace.blocks),
          digest({ ...workspace, id: undefined }),
          JSON.stringify({ op: "create" }),
          now,
        ],
      );
      await client.query("COMMIT");
      return workspace;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async load(tenantId: string, workspaceId: string): Promise<QueryWorkspaceV2> {
    const client = await this.pool.connect();
    try {
      await beginSemanticV2Tenant(client, tenantId, true);
      const result = await client.query(
        `SELECT workspace_id,tenant_id,publication_hash,overlay_version,revision,
                question_id,blocks,status,created_at,updated_at,
                derived_from_workspace_id,derived_from_revision
         FROM control_plane.query_workspaces_v2
         WHERE tenant_id=$1 AND workspace_id=$2`,
        [tenantId, workspaceId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (!row) throw new Error(`Workspace ${workspaceId} was not found.`);
      return queryWorkspaceV2Schema.parse({
        id: row.workspace_id,
        tenantId: row.tenant_id,
        publicationHash: row.publication_hash,
        overlayVersion: row.overlay_version,
        revision: Number(row.revision),
        questionId: row.question_id,
        ...(row.derived_from_workspace_id
          ? {
              derivedFrom: {
                workspaceId: row.derived_from_workspace_id,
                revision: Number(row.derived_from_revision),
              },
            }
          : {}),
        blocks: row.blocks,
        status: row.status,
        createdAt: new Date(String(row.created_at)).toISOString(),
        updatedAt: new Date(String(row.updated_at)).toISOString(),
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async applyPatch(
    tenantId: string,
    workspaceId: string,
    patch: WorkspacePatchV2,
  ): Promise<QueryWorkspaceV2> {
    const current = await this.load(tenantId, workspaceId);
    const updated = applyWorkspacePatchV2(
      current,
      patch,
      this.clock().toISOString(),
    );
    const client = await this.pool.connect();
    try {
      await beginSemanticV2Tenant(client, tenantId);
      const changed = await client.query(
        `UPDATE control_plane.query_workspaces_v2
         SET revision=$3,status='draft',blocks=$4::jsonb,updated_at=$5
         WHERE tenant_id=$1 AND workspace_id=$2 AND revision=$6 AND status IN ('draft','failed')
         RETURNING revision`,
        [
          tenantId,
          workspaceId,
          updated.revision,
          JSON.stringify(updated.blocks),
          updated.updatedAt,
          patch.expectedRevision,
        ],
      );
      if (!changed.rows[0]) throw new Error("WORKSPACE_REVISION_CONFLICT");
      await client.query(
        `INSERT INTO control_plane.query_workspace_revisions_v2(
           tenant_id,workspace_id,revision,status,blocks,workspace_hash,mutation,created_at
         ) VALUES ($1,$2,$3,'draft',$4::jsonb,$5,$6::jsonb,$7)`,
        [
          tenantId,
          workspaceId,
          updated.revision,
          JSON.stringify(updated.blocks),
          digest({ ...updated, id: undefined }),
          JSON.stringify(patch),
          updated.updatedAt,
        ],
      );
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async setStatus(
    tenantId: string,
    workspaceId: string,
    expectedRevision: number,
    status: QueryWorkspaceV2["status"],
  ): Promise<QueryWorkspaceV2> {
    const client = await this.pool.connect();
    try {
      await beginSemanticV2Tenant(client, tenantId);
      const result = await client.query(
        `UPDATE control_plane.query_workspaces_v2
         SET status=$4,updated_at=$5
         WHERE tenant_id=$1 AND workspace_id=$2 AND revision=$3
         RETURNING workspace_id,tenant_id,publication_hash,overlay_version,revision,
                   question_id,blocks,status,created_at,updated_at,
                   derived_from_workspace_id,derived_from_revision`,
        [
          tenantId,
          workspaceId,
          expectedRevision,
          status,
          this.clock().toISOString(),
        ],
      );
      if (!result.rows[0]) throw new Error("WORKSPACE_REVISION_CONFLICT");
      await client.query("COMMIT");
      const row = result.rows[0];
      return queryWorkspaceV2Schema.parse({
        id: row.workspace_id,
        tenantId: row.tenant_id,
        publicationHash: row.publication_hash,
        overlayVersion: row.overlay_version,
        revision: Number(row.revision),
        questionId: row.question_id,
        ...(row.derived_from_workspace_id
          ? {
              derivedFrom: {
                workspaceId: row.derived_from_workspace_id,
                revision: Number(row.derived_from_revision),
              },
            }
          : {}),
        blocks: row.blocks,
        status: row.status,
        createdAt: new Date(String(row.created_at)).toISOString(),
        updatedAt: new Date(String(row.updated_at)).toISOString(),
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresEvidenceArtifactStoreV2 implements EvidenceArtifactStoreV2 {
  constructor(private readonly pool: PgPoolLike) {}

  async persistExecution(
    input: Readonly<{
      tenantId: string;
      workspaceId: string;
      workspaceRevision: number;
      execution: ExecutedWorkspaceV2;
      compiled: CompiledWorkspaceV2;
      cacheKey: string;
      cachedFromExecutionId?: string;
    }>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await beginSemanticV2Tenant(client, input.tenantId);
      await client.query(
        `INSERT INTO control_plane.query_execution_snapshots_v2(
           tenant_id,execution_id,workspace_id,workspace_revision,publication_hash,
           normalized_plan_hash,cache_key,cached_from_execution_id,compiler_output_hash,result_digest,source_watermarks,
           validation,terminal_state
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)`,
        [
          input.tenantId,
          input.execution.executionId,
          input.workspaceId,
          input.workspaceRevision,
          input.compiled.publicationHash,
          input.compiled.normalizedPlanHash,
          input.cacheKey,
          input.cachedFromExecutionId ?? null,
          digest(
            input.compiled.queries.map(({ sql, parameters }) => ({
              sql,
              parameters,
            })),
          ),
          input.execution.resultDigest,
          JSON.stringify(input.execution.sourceWatermarks),
          JSON.stringify(input.execution.validation),
          input.execution.terminalState,
        ],
      );
      const artifacts = [
        ...input.execution.queries.map((query) => ({
          type: "result",
          artifact: query,
        })),
        ...input.execution.claims.map((claim) => ({
          type: "claim",
          artifact: claim,
        })),
      ];
      for (const item of artifacts) {
        const artifactDigest = digest(item.artifact);
        await client.query(
          `INSERT INTO control_plane.evidence_artifacts_v2(
             tenant_id,evidence_id,execution_id,evidence_type,artifact,artifact_digest
           ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
          [
            input.tenantId,
            ulid(),
            input.execution.executionId,
            item.type,
            JSON.stringify(item.artifact),
            artifactDigest,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async loadCachedExecution(
    tenantId: string,
    cacheKey: string,
  ): Promise<Readonly<{
    execution: ExecutedWorkspaceV2;
    originExecutionId: string;
  }> | null> {
    const client = await this.pool.connect();
    try {
      await beginSemanticV2Tenant(client, tenantId, true);
      const result = await client.query(
        `SELECT execution_payload,origin_execution_id
           FROM control_plane.semantic_result_cache_v2
          WHERE tenant_id=$1 AND cache_key=$2`,
        [tenantId, cacheKey],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row
        ? Object.freeze({
            execution: row.execution_payload as ExecutedWorkspaceV2,
            originExecutionId: String(row.origin_execution_id),
          })
        : null;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async persistCache(
    input: Readonly<{
      tenantId: string;
      cacheKey: string;
      publicationHash: string;
      overlayVersion: string;
      normalizedPlanHash: string;
      connectionSet: readonly string[];
      sourceWatermarks: Readonly<Record<string, string>>;
      execution: ExecutedWorkspaceV2;
    }>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await beginSemanticV2Tenant(client, input.tenantId);
      await client.query(
        `INSERT INTO control_plane.semantic_result_cache_v2(
           tenant_id,cache_key,publication_hash,overlay_version,normalized_plan_hash,
           connection_set,source_watermarks,execution_payload,result_digest,origin_execution_id
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
         ON CONFLICT (tenant_id,cache_key) DO NOTHING`,
        [
          input.tenantId,
          input.cacheKey,
          input.publicationHash,
          input.overlayVersion,
          input.normalizedPlanHash,
          JSON.stringify([...input.connectionSet].sort()),
          JSON.stringify(input.sourceWatermarks),
          JSON.stringify(input.execution),
          input.execution.resultDigest,
          input.execution.executionId,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
