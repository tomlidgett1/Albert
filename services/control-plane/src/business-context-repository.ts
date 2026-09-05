/**
 * Business context repository: the per-tenant business context document
 * (context-layer/) as the control plane stores it.
 *
 * Two access paths:
 *   - Web (authenticated user, membership-scoped RPCs) — used by the API route,
 *     the conversation route and the in-turn refresh save.
 *   - Service (direct database login held by operators / the CLI) — used by
 *     scripts/albert-business-context.mts to seed or inspect a tenant's row.
 */
import { z } from "zod";
import { requireUser, ControlPlaneError } from "./web-repository.js";
import {
  businessContextDocumentSchema,
  BUSINESS_CONTEXT_SECTIONS,
  type BusinessContextDocument,
  type BusinessContextSection,
  type StoredBusinessContext,
} from "../../../packages/albert-v3/src/context-layer/schema.js";
import { renderBusinessContext } from "../../../packages/albert-v3/src/context-layer/render.js";

type SupabaseClient = Awaited<ReturnType<typeof requireUser>>["supabase"];

const rowSchema = z.object({
  document: z.unknown(),
  rendered: z.string(),
  status: z.enum(["draft", "confirmed"]),
  ownerLocked: z.array(z.string()).nullish(),
  connectors: z.array(z.string()).nullish(),
  generatorVersion: z.string().nullish(),
  model: z.string().nullish(),
  dataThrough: z.string().nullish(),
  generatedAt: z.string().nullish(),
  confirmedAt: z.string().nullish(),
  revision: z.number().int().nullish(),
  updatedAt: z.string(),
});

function singleton(value: unknown): unknown {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function toStored(raw: unknown): StoredBusinessContext | null {
  const value = singleton(raw);
  if (value === null || value === undefined) return null;
  const parsed = rowSchema.safeParse(value);
  if (!parsed.success) throw new ControlPlaneError("Business context returned invalid data.", 503);
  const document = businessContextDocumentSchema.safeParse(parsed.data.document);
  if (!document.success) throw new ControlPlaneError("Business context document is invalid.", 503);
  const locked = (parsed.data.ownerLocked ?? []).filter((s): s is BusinessContextSection => (BUSINESS_CONTEXT_SECTIONS as readonly string[]).includes(s));
  return Object.freeze({
    document: document.data,
    rendered: parsed.data.rendered,
    status: parsed.data.status,
    ownerLocked: Object.freeze(locked),
    generatorVersion: parsed.data.generatorVersion ?? null,
    model: parsed.data.model ?? null,
    dataThrough: parsed.data.dataThrough ?? null,
    generatedAt: parsed.data.generatedAt ?? null,
    confirmedAt: parsed.data.confirmedAt ?? null,
    updatedAt: parsed.data.updatedAt,
    connectors: Object.freeze([...(parsed.data.connectors ?? [])]),
  });
}

/** The tenant's business context, or null when none has been generated yet. */
export async function loadBusinessContext(supabaseClient?: SupabaseClient): Promise<StoredBusinessContext | null> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_business_context");
  if (error) throw new ControlPlaneError("Business context could not be loaded.", 503);
  return toStored(data);
}

export type SaveBusinessContextInput = Readonly<{
  document: BusinessContextDocument;
  /** Deterministic rendering; recomputed from the document when omitted. */
  rendered?: string;
  source: "generated" | "owner";
  ownerLocked?: readonly BusinessContextSection[];
  facts?: unknown;
  generatorVersion?: string | null;
  model?: string | null;
  dataThrough?: string | null;
  connectors?: readonly string[];
}>;

/** Owner/manager only (enforced by the RPC). */
export async function saveBusinessContext(input: SaveBusinessContextInput, supabaseClient?: SupabaseClient): Promise<StoredBusinessContext> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const document = businessContextDocumentSchema.parse(input.document);
  const { data, error } = await supabase.rpc("albert_save_business_context", {
    p_document: document,
    p_rendered: input.rendered ?? renderBusinessContext(document),
    p_source: input.source,
    p_owner_locked: input.ownerLocked ? [...input.ownerLocked] : null,
    p_facts: input.facts ?? null,
    p_generator_version: input.generatorVersion ?? null,
    p_model: input.model ?? null,
    p_data_through: input.dataThrough ?? null,
    p_connectors: input.connectors ? [...input.connectors] : null,
  });
  if (error) {
    const status = /insufficient role|no active organisation/iu.test(error.message) ? 403 : 503;
    throw new ControlPlaneError(status === 403 ? "Only owners and managers can change the business context." : "Business context could not be saved.", status);
  }
  const stored = toStored(data);
  if (!stored) throw new ControlPlaneError("Business context could not be saved.", 503);
  return stored;
}

export async function confirmBusinessContext(supabaseClient?: SupabaseClient): Promise<StoredBusinessContext> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_confirm_business_context");
  if (error) {
    const status = /insufficient role|no active organisation/iu.test(error.message) ? 403 : /no business context/iu.test(error.message) ? 404 : 503;
    throw new ControlPlaneError(status === 403 ? "Only owners and managers can confirm the business context." : status === 404 ? "There is no business context to confirm yet." : "Business context could not be confirmed.", status);
  }
  const stored = toStored(data);
  if (!stored) throw new ControlPlaneError("Business context could not be confirmed.", 503);
  return stored;
}

// ---------------------------------------------------------------------------
// Service path (direct database login; operators and the CLI only)
// ---------------------------------------------------------------------------

async function servicePool() {
  const { Pool } = await import("pg");
  const url = process.env.CONTROL_PLANE_DATABASE_URL?.trim();
  if (!url) throw new Error("CONTROL_PLANE_DATABASE_URL is not set.");
  return new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/u.test(url) ? undefined : { rejectUnauthorized: false }, max: 1 });
}

export async function loadBusinessContextAsService(tenantId: string): Promise<StoredBusinessContext | null> {
  const pool = await servicePool();
  try {
    const { rows } = await pool.query<{ row: unknown }>(
      "SELECT control_plane.business_context_row_json(ctx) AS row FROM control_plane.tenant_business_context AS ctx WHERE ctx.tenant_id = $1",
      [tenantId],
    );
    return rows[0] ? toStored(rows[0].row) : null;
  } finally {
    await pool.end();
  }
}

/** Upsert as a generated refresh (keeps owner locks/status), recording a revision. Operator use. */
export async function saveBusinessContextAsService(input: SaveBusinessContextInput & { tenantId: string }): Promise<void> {
  const pool = await servicePool();
  const document = businessContextDocumentSchema.parse(input.document);
  const rendered = input.rendered ?? renderBusinessContext(document);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ revision: number }>(
      `INSERT INTO control_plane.tenant_business_context
         (tenant_id, document, rendered, facts, status, owner_locked, connectors, generator_version, model, data_through, generated_at, revision, updated_at)
       VALUES ($1, $2::jsonb, $3, $4::jsonb, 'draft', $5::jsonb, $6::jsonb, $7, $8, $9, now(), 1, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         document = EXCLUDED.document,
         rendered = EXCLUDED.rendered,
         facts = coalesce(EXCLUDED.facts, control_plane.tenant_business_context.facts),
         connectors = coalesce(EXCLUDED.connectors, control_plane.tenant_business_context.connectors),
         generator_version = coalesce(EXCLUDED.generator_version, control_plane.tenant_business_context.generator_version),
         model = coalesce(EXCLUDED.model, control_plane.tenant_business_context.model),
         data_through = coalesce(EXCLUDED.data_through, control_plane.tenant_business_context.data_through),
         generated_at = now(),
         revision = control_plane.tenant_business_context.revision + 1,
         updated_at = now()
       RETURNING revision`,
      [
        input.tenantId, JSON.stringify(document), rendered, input.facts ? JSON.stringify(input.facts) : null,
        JSON.stringify(input.ownerLocked ?? []), JSON.stringify(input.connectors ?? []),
        input.generatorVersion ?? null, input.model ?? null, input.dataThrough ?? null,
      ],
    );
    await client.query(
      "INSERT INTO control_plane.tenant_business_context_revisions (tenant_id, revision, source, document, rendered) VALUES ($1, $2, 'generated', $3::jsonb, $4)",
      [input.tenantId, rows[0]?.revision ?? 1, JSON.stringify(document), rendered],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
