/**
 * Homepage recommended analysis (ADR 0117, migrations 0163/0164): the
 * standing corpus (deeper briefs + coverage index) plus the per-user cache
 * of the next brief.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ANALYSIS_DOMAINS,
  ANALYTICAL_MOVES,
  type AnalysisBrief,
  type CoverageThread,
  type ProactiveSignal,
  type RecommendedQuestion,
} from "../../recommended-analysis/src/playbook.js";
import { fingerprintCorpus, type AnalysisCorpus } from "../../recommended-analysis/src/corpus.js";
import { isRecommendedTool } from "../../recommended-analysis/src/tools.js";
import { proactivePanelSchema } from "./proactive-repository.js";
import { ControlPlaneError, requireUser } from "./web-repository.js";

type SupabaseClient = Awaited<ReturnType<typeof requireUser>>["supabase"];

const insightSchema = z.object({
  value: z.union([z.string(), z.number()]).transform((value) => String(value)),
  label: z.union([z.string(), z.number()]).transform((value) => String(value)),
  detail: z.union([z.string(), z.number()]).optional().transform((value) => (
    value === undefined ? undefined : String(value)
  )),
  sentiment: z.enum(["positive", "negative", "neutral"]).optional(),
}).passthrough();

const briefSchema = z.object({
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  title: z.string().min(1),
  updatedAt: z.string(),
  turnId: z.string().min(8),
  userQuestion: z.string().min(1),
  answerState: z.string().nullable(),
  completedAt: z.string().nullable(),
  answerExcerpt: z.string(),
  followUps: z.array(z.string()),
  keyInsights: z.array(insightSchema),
  claims: z.array(z.string()),
  askedQuestions: z.array(z.string()),
});

const coverageSchema = z.object({
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  title: z.string().min(1),
  updatedAt: z.string(),
  question: z.string(),
});

const recommendationSchema = z.object({
  id: z.string().min(4).max(80),
  title: z.string().min(8).max(110).optional(),
  question: z.string().min(8).max(200),
  why: z.string().min(8).max(200),
  move: z.enum(ANALYTICAL_MOVES),
  domain: z.enum(ANALYSIS_DOMAINS),
  tool: z.string().min(1).max(40).nullish(),
  fromTitle: z.string().min(1).max(120),
  fromConversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).nullable(),
}).strict();

const cacheSchema = z.object({
  sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  sourceCount: z.number().int().min(0).max(40),
  verdict: z.string().max(400).optional().default(""),
  recommendations: z.array(recommendationSchema).max(8),
  model: z.string().min(1).max(120),
  generatedAt: z.string(),
  windowStart: z.string().nullish(),
  windowEnd: z.string().nullish(),
});

function singleton(value: unknown): unknown {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function toBrief(raw: unknown): AnalysisBrief | null {
  const parsed = briefSchema.safeParse(raw);
  if (!parsed.success) return null;
  return Object.freeze({
    conversationId: parsed.data.conversationId,
    title: parsed.data.title,
    updatedAt: parsed.data.updatedAt,
    turnId: parsed.data.turnId,
    userQuestion: parsed.data.userQuestion,
    answerState: parsed.data.answerState,
    completedAt: parsed.data.completedAt,
    answerExcerpt: parsed.data.answerExcerpt,
    followUps: Object.freeze(parsed.data.followUps.map((item) => item.trim()).filter(Boolean)),
    keyInsights: Object.freeze(parsed.data.keyInsights.map((item) => Object.freeze({
      value: String(item.value ?? "").trim(),
      label: String(item.label ?? "").trim(),
      ...(item.detail ? { detail: String(item.detail).trim() } : {}),
      ...(item.sentiment ? { sentiment: item.sentiment } : {}),
    }))),
    claims: Object.freeze(parsed.data.claims.map((item) => item.trim()).filter(Boolean)),
    askedQuestions: Object.freeze(parsed.data.askedQuestions.map((item) => item.trim()).filter(Boolean)),
  });
}

function toCoverage(raw: unknown): CoverageThread | null {
  const parsed = coverageSchema.safeParse(raw);
  if (!parsed.success) return null;
  return Object.freeze({
    conversationId: parsed.data.conversationId,
    title: parsed.data.title,
    updatedAt: parsed.data.updatedAt,
    question: parsed.data.question,
  });
}

export function briefsFingerprint(corpus: AnalysisCorpus): string {
  return createHash("sha256").update(fingerprintCorpus(corpus)).digest("hex");
}

export async function loadRecommendedAnalysisCorpus(
  supabaseClient?: SupabaseClient,
): Promise<Readonly<{ briefs: readonly AnalysisBrief[]; coverage: readonly CoverageThread[] }>> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_recommended_analysis_corpus");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      return loadCorpusFallback(supabase);
    }
    throw new ControlPlaneError("Recent analysis could not be loaded.", 503);
  }
  const value = data && typeof data === "object" && !Array.isArray(data)
    ? data as { briefs?: unknown; coverage?: unknown }
    : { briefs: data, coverage: [] };
  const briefs = Array.isArray(value.briefs)
    ? value.briefs.map(toBrief).filter((brief): brief is AnalysisBrief => brief !== null)
    : [];
  const coverage = Array.isArray(value.coverage)
    ? value.coverage.map(toCoverage).filter((thread): thread is CoverageThread => thread !== null)
    : [];
  return Object.freeze({
    briefs: Object.freeze(briefs),
    coverage: Object.freeze(coverage),
  });
}

async function loadCorpusFallback(
  supabase: SupabaseClient,
): Promise<Readonly<{ briefs: readonly AnalysisBrief[]; coverage: readonly CoverageThread[] }>> {
  const { data, error } = await supabase.rpc("albert_recent_analysis_briefs", { p_limit: 10 });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new ControlPlaneError("The recommended analysis migration is not deployed.", 503);
    }
    throw new ControlPlaneError("Recent analysis could not be loaded.", 503);
  }
  const briefs = Array.isArray(data)
    ? data.map(toBrief).filter((brief): brief is AnalysisBrief => brief !== null)
    : [];
  return Object.freeze({
    briefs: Object.freeze(briefs),
    coverage: Object.freeze(briefs.map((brief) => ({
      conversationId: brief.conversationId,
      title: brief.title,
      updatedAt: brief.updatedAt,
      question: brief.userQuestion,
    }))),
  });
}

export async function loadProactiveSignal(
  supabaseClient?: SupabaseClient,
): Promise<ProactiveSignal | null> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_proactive_panel");
  if (error || data == null) return null;
  const parsed = proactivePanelSchema.safeParse(data);
  if (!parsed.success || !parsed.data.run) return null;
  const run = parsed.data.run;
  const highlights = run.synthesis?.highlights ?? run.findings
    .filter((finding) => finding.status === "completed" && finding.headline)
    .slice(0, 5)
    .map((finding) => ({
      headline: finding.headline ?? finding.agentTitle,
      why: finding.summary?.slice(0, 240) || finding.agentTagline,
      question: finding.questions[0] ?? `What should I look at next in ${finding.agentTitle.toLowerCase()}?`,
      tone: "attention" as const,
    }));
  if (!run.synthesis && highlights.length === 0) return null;
  return Object.freeze({
    runId: run.runId,
    completedAt: run.completedAt,
    verdict: run.synthesis?.verdict ?? null,
    highlights: Object.freeze(highlights.map((item) => Object.freeze(item))),
  });
}

/** A stored row keeps its tool only when it is one Albert knows; the route re-derives the rest from the domain. */
function storedRecommendation(item: z.infer<typeof recommendationSchema>): RecommendedQuestion {
  return Object.freeze({
    id: item.id,
    ...(item.title ? { title: item.title } : {}),
    question: item.question,
    why: item.why,
    move: item.move,
    domain: item.domain,
    tool: isRecommendedTool(item.tool) ? item.tool : null,
    fromTitle: item.fromTitle,
    fromConversationId: item.fromConversationId,
  });
}

export type RecommendedAnalysisCache = Readonly<{
  sourceFingerprint: string;
  sourceCount: number;
  verdict: string;
  recommendations: readonly RecommendedQuestion[];
  model: string;
  generatedAt: string;
  windowStart?: string | null;
  windowEnd?: string | null;
}>;

export async function loadRecommendedAnalysisCache(
  supabaseClient?: SupabaseClient,
): Promise<RecommendedAnalysisCache | null> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_recommended_analysis");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new ControlPlaneError("The recommended analysis migration is not deployed.", 503);
    }
    throw new ControlPlaneError("Recommended analysis could not be loaded.", 503);
  }
  const value = singleton(data);
  if (value == null) return null;
  const parsed = cacheSchema.safeParse(value);
  if (!parsed.success) return null;
  return Object.freeze({
    sourceFingerprint: parsed.data.sourceFingerprint,
    sourceCount: parsed.data.sourceCount,
    verdict: parsed.data.verdict,
    recommendations: Object.freeze(parsed.data.recommendations.map(storedRecommendation)),
    model: parsed.data.model,
    generatedAt: parsed.data.generatedAt,
    windowStart: parsed.data.windowStart,
    windowEnd: parsed.data.windowEnd,
  });
}

export async function saveRecommendedAnalysisCache(input: Readonly<{
  sourceFingerprint: string;
  sourceCount: number;
  verdict: string;
  recommendations: readonly RecommendedQuestion[];
  model: string;
}>, supabaseClient?: SupabaseClient): Promise<RecommendedAnalysisCache> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_save_recommended_analysis", {
    p_source_fingerprint: input.sourceFingerprint,
    p_source_count: input.sourceCount,
    p_recommendations: input.recommendations,
    p_model: input.model,
    p_verdict: input.verdict,
  });
  if (error) throw new ControlPlaneError("Recommended analysis could not be saved.", 503);
  const parsed = cacheSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("Recommended analysis returned invalid state.", 503);
  return Object.freeze({
    sourceFingerprint: parsed.data.sourceFingerprint,
    sourceCount: parsed.data.sourceCount,
    verdict: parsed.data.verdict,
    recommendations: Object.freeze(parsed.data.recommendations.map(storedRecommendation)),
    model: parsed.data.model,
    generatedAt: parsed.data.generatedAt,
  });
}
