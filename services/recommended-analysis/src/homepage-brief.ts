import { DAILY_BRIEF_MAX_AGE_MS, isActionRecommendation, isFreshDailyBrief } from "./daily-brief.js";
import type { RecommendedQuestion } from "./playbook.js";
import { normaliseRecommendedTools } from "./tools.js";

type StoredBrief = Readonly<{
  model: string;
  generatedAt: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  sourceFingerprint: string;
  sourceCount: number;
  verdict: string;
  recommendations: readonly RecommendedQuestion[];
}>;

/** The daily selection of material investigations from the last seven days. */
export function homepageDailyBrief(cache: StoredBrief | null, connectorKeys: readonly string[], timezone: string, now = new Date()) {
  const connectors = normaliseRecommendedTools(connectorKeys);
  const fresh = cache !== null && isFreshDailyBrief(cache, now);
  return {
    source: fresh ? "daily" as const : cache ? "stale" as const : "empty" as const,
    recommendations: fresh ? cache.recommendations.filter((item) => isActionRecommendation(item.title, item.why) && item.tool && connectors.includes(item.tool)).slice(0, 3) : [],
    verdict: fresh ? cache.verdict : "",
    sourceCount: fresh ? cache.sourceCount : 0,
    fingerprint: fresh ? cache.sourceFingerprint : "",
    connectors,
    timezone,
    generatedAt: fresh ? cache.generatedAt : null,
    windowStart: fresh ? cache.windowStart! : null,
    windowEnd: fresh ? cache.windowEnd! : null,
    expiresAt: fresh ? new Date(Date.parse(cache.windowEnd!) + DAILY_BRIEF_MAX_AGE_MS).toISOString() : null,
  };
}
