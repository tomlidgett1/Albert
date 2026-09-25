/**
 * The business context document: a dense, structured description of one
 * customer's business that every Albert turn is grounded in — what the
 * business is, how it makes money, its scale and shape, what the owner is
 * trying to achieve, the owner's own vocabulary, and what each connected tool
 * is the source of truth for.
 *
 * The shape is connector-agnostic. It is populated by a generator that reads
 * whatever tools are connected (through config-declared probes) and by the
 * owner (edits and confirmation), rendered deterministically to ~400 words for
 * the prompt, and stored per tenant in the control plane.
 */
import { z } from "zod";

const short = (max: number) => z.string().trim().min(1).max(max);

export const BUSINESS_MODELS = ["retail", "services", "hybrid", "hospitality", "wholesale", "online", "manufacturing", "professional_services", "other"] as const;

export const businessContextDocumentSchema = z.object({
  version: z.literal(1),
  identity: z.object({
    /** Trading name as the owner uses it. */
    name: short(120),
    /** One or two sentences: what it is, where, and how it operates. */
    summary: short(360),
    industry: short(80),
    model: z.enum(BUSINESS_MODELS),
    /** How customers buy: in-store, online, workshop/service desk, wholesale accounts… */
    channels: z.array(short(60)).max(6),
    locations: z.array(z.object({ name: short(80), role: short(80).nullable() })).max(8),
  }),
  revenue: z.object({
    /** What the shares are measured on, e.g. "Lightspeed sales lines, 12 months to Jul 2026, GST-inclusive". */
    basis: short(160),
    /** Streams ordered by importance; share is a fraction of the basis when known. */
    streams: z.array(z.object({
      name: short(80),
      share: z.number().min(0).max(1).nullable(),
      note: short(140).nullable(),
    })).max(8),
    /** Rounded annual band, never a precise figure: "roughly $450k–$550k a year". */
    annualBand: short(120).nullable(),
    /** Peak and quiet periods, one sentence. */
    seasonality: short(240).nullable(),
  }),
  scale: z.object({
    headcount: short(160).nullable(),
    customers: short(160).nullable(),
    catalogue: short(160).nullable(),
    other: z.array(short(120)).max(4),
  }),
  goals: z.object({
    /** Owner-stated goals and priorities (growth, margin, labour efficiency, cash flow…). */
    ownerStated: z.array(short(140)).max(6),
    /** Data-suggested watch-points the generator proposes; the owner confirms or removes them. */
    suggestedFocus: z.array(short(160)).max(5),
    /** How the owner likes periods compared ("same weekday-aligned period last year"). */
    comparisonPreference: short(120).nullable(),
  }),
  /** Owner vocabulary → what it maps to in the data. */
  vocabulary: z.array(z.object({
    term: short(60),
    meaning: short(160),
    /** Optional pointer into the semantic layer: a view, member or filter value. */
    mapsTo: short(120).nullable(),
  })).max(14),
  tools: z.array(z.object({
    /** Connector key as the control plane names it (lightspeed-r, xero, deputy, …). */
    connector: short(40),
    /** Human label ("Lightspeed Retail"). */
    label: short(60),
    /** What this tool is the source of truth for here, one line. */
    role: short(180),
    sourceOfTruthFor: z.array(short(40)).max(8),
    dataFrom: short(10).nullable(),
    dataThrough: short(10).nullable(),
  })).max(12),
  /** Data quirks that change interpretation ("workshop statuses all read as open"). */
  cautions: z.array(short(200)).max(6),
});

export type BusinessContextDocument = z.infer<typeof businessContextDocumentSchema>;

/** Top-level sections the owner can lock (owner edits win over regeneration). */
export const BUSINESS_CONTEXT_SECTIONS = ["identity", "revenue", "scale", "goals", "vocabulary", "tools", "cautions"] as const;
export type BusinessContextSection = (typeof BUSINESS_CONTEXT_SECTIONS)[number];

export const businessContextStatusSchema = z.enum(["draft", "confirmed"]);
export type BusinessContextStatus = z.infer<typeof businessContextStatusSchema>;

/** The stored record as the repository returns it. */
export type StoredBusinessContext = Readonly<{
  document: BusinessContextDocument;
  /** Deterministic prompt rendering of `document` (see render.ts). */
  rendered: string;
  status: BusinessContextStatus;
  /** Sections the owner has edited; regeneration keeps them verbatim. */
  ownerLocked: readonly BusinessContextSection[];
  generatorVersion: string | null;
  model: string | null;
  /** Latest source watermark the generator saw. */
  dataThrough: string | null;
  generatedAt: string | null;
  confirmedAt: string | null;
  updatedAt: string;
  /** Connector keys the document was generated for. */
  connectors: readonly string[];
}>;

/** What the engine needs on a turn: the rendering plus the parts used structurally. */
export type BusinessContextForTurn = Readonly<{
  document: BusinessContextDocument;
  rendered: string;
  status: BusinessContextStatus;
  generatedAt: string | null;
  connectors: readonly string[];
}>;

export const GENERATOR_VERSION = "2026-08-18.1";
