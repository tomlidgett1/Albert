/**
 * Discover repository (ADR 0130, migration 0182): the per-tenant cache of
 * the personalised Discover cards.
 *
 * Unlike the recommended-analysis cache, a missing migration is not an
 * error here: Discover keeps working from the library plus a fresh model
 * pass (rate-limited) until 0182 is applied, so a UI feature never 503s on
 * a cache table.
 */
import { z } from "zod";
import {
  DISCOVER_CONNECTORS,
  DISCOVER_DOMAINS,
  type DiscoverCard,
} from "../../discover/src/library.js";
import { ControlPlaneError, requireUser } from "./web-repository.js";

type SupabaseClient = Awaited<ReturnType<typeof requireUser>>["supabase"];

const cardSchema = z.object({
  id: z.string().min(4).max(80),
  title: z.string().min(4).max(80),
  why: z.string().min(8).max(200),
  prompt: z.string().min(8).max(260),
  domain: z.enum(DISCOVER_DOMAINS),
  tools: z.array(z.enum(DISCOVER_CONNECTORS)).min(1).max(4),
}).strict();

const cacheSchema = z.object({
  sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  cards: z.array(cardSchema).max(40),
  model: z.string().min(1).max(120),
  generatedAt: z.string(),
});

export type DiscoverCache = Readonly<{
  sourceFingerprint: string;
  cards: readonly DiscoverCard[];
  model: string;
  generatedAt: string;
}>;

function singleton(value: unknown): unknown {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function migrationMissing(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

function toCache(raw: unknown): DiscoverCache | null {
  const value = singleton(raw);
  if (value == null) return null;
  const parsed = cacheSchema.safeParse(value);
  if (!parsed.success) return null;
  return Object.freeze({
    sourceFingerprint: parsed.data.sourceFingerprint,
    cards: Object.freeze(parsed.data.cards.map((card) => Object.freeze({
      ...card,
      tools: Object.freeze([...card.tools]),
    }))),
    model: parsed.data.model,
    generatedAt: parsed.data.generatedAt,
  });
}

/** The tenant's cached cards, or null when none exist (or 0182 is not deployed). */
export async function loadDiscoverCache(supabaseClient?: SupabaseClient): Promise<DiscoverCache | null> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_discover_prompts");
  if (error) {
    if (migrationMissing(error)) return null;
    throw new ControlPlaneError("Discover could not be loaded.", 503);
  }
  return toCache(data);
}

/** Persist the personalised cards for every member of the tenant. Null when 0182 is not deployed. */
export async function saveDiscoverCache(input: Readonly<{
  sourceFingerprint: string;
  cards: readonly DiscoverCard[];
  model: string;
}>, supabaseClient?: SupabaseClient): Promise<DiscoverCache | null> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_save_discover_prompts", {
    p_source_fingerprint: input.sourceFingerprint,
    p_cards: input.cards,
    p_model: input.model,
  });
  if (error) {
    if (migrationMissing(error)) return null;
    throw new ControlPlaneError("Discover could not be saved.", 503);
  }
  const stored = toCache(data);
  if (!stored) throw new ControlPlaneError("Discover returned invalid state.", 503);
  return stored;
}
