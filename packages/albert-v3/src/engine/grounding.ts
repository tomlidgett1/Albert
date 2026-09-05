import { createHash } from "node:crypto";
import type { AnswerState, TraceProvenance } from "../../../shared/src/index.js";
import type { Lane } from "./orchestrator.js";
import type { V3TurnContext } from "./context.js";

export const MISSING_QUERY_RETRY_MESSAGE =
  "You returned a final answer without running a governed data query. "
  + "Call run_cube_query, top_n_breakdown, or compare_periods "
  + "(or the matching Shopify query tool) before answering. "
  + "Do not describe what you will do. Retrieve the figures first.";

const UNGROUNDED_FOLLOW_UPS = [
  "Try the question again",
  "Show sales this month",
  "Break this down by product",
] as const;

/**
 * The retry chip re-sends the owner's own question rather than the literal
 * text "Try the question again" (which, clicked, became a new turn with that
 * as its message and no anchor to what was actually asked).
 */
export function retryFollowUps(originalMessage: string): string[] {
  const question = originalMessage.replace(/\s+/gu, " ").trim();
  if (question.length >= 4 && question.length <= 160) return [question];
  return ["Show sales this month"];
}

export type UngroundedFinalAnswer = {
  answer: string;
  state: "Unavailable";
  followUps: string[];
  assumptionsDisclosed: string[];
};

/** Data lanes must execute a query this turn. Explain may rest on prior queries. */
export function laneRequiresQueryEvidence(lane: Lane): boolean {
  return lane === "quick" || lane === "analytical" || lane === "deep";
}

/** Lanes whose answer may rest entirely on results retrieved in earlier turns. */
export function laneMayReusePriorResults(lane: Lane): boolean {
  return lane === "represent" || lane === "explain" || lane === "meta";
}

/**
 * Grok (and sometimes other models) fill the structured-output schema with a
 * commitment instead of calling tools. That prose must never ship as an answer.
 */
export function looksLikeUngroundedPlan(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /^(?:i(?:['’]ll| will| am going to| can)|let me)\b/iu.test(trimmed)
    || /\bi(?:['’]ll| will) (?:now )?(?:break|look|check|pull|run|start|query)\b/iu.test(trimmed);
}

export function ungroundedOwnerAnswer(): string {
  return "I could not retrieve those figures from the connected data. Try the question again.";
}

export function ungroundedFinalAnswer(): UngroundedFinalAnswer {
  return {
    answer: ungroundedOwnerAnswer(),
    state: "Unavailable",
    followUps: [...UNGROUNDED_FOLLOW_UPS],
    assumptionsDisclosed: [],
  };
}

export function emptyTurnProvenance(timezone: string): TraceProvenance {
  return {
    sources: [],
    timeRange: {
      label: "Requested period",
      start: "unknown",
      end: "unknown",
      timezone,
    },
    definitions: [],
    semanticBundleHash: "albert-v3-cube-no-queries",
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
  };
}

export function buildTurnProvenance(context: V3TurnContext): TraceProvenance {
  if (context.executedQueries.length === 0) {
    const definitions = context.definitionEvidence ?? [];
    if (definitions.length > 0) {
      const definitionDigest = createHash("sha256")
        .update(JSON.stringify([...definitions].sort((left, right) => left.member.localeCompare(right.member))))
        .digest("hex")
        .slice(0, 16);
      return {
        // Definitions are model metadata, not a read of connector data, so no
        // source freshness claim belongs here.
        sources: [],
        timeRange: {
          label: "Not applicable — definition",
          start: "not applicable",
          end: "not applicable",
          timezone: context.config.timezone,
        },
        definitions: definitions.map((definition) => ({
          metric: definition.member,
          label: definition.label,
          definition: definition.definition,
          view: definition.view,
          kind: definition.kind,
        })),
        semanticBundleHash: `albert-v3-definitions-${definitionDigest}`,
        identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
      };
    }
    return emptyTurnProvenance(context.config.timezone);
  }
  const now = new Date().toISOString();
  const yamlDigest = createHash("sha256")
    .update(context.executedQueries.map((query) => query.queryYaml).join("\n---\n"))
    .digest("hex")
    .slice(0, 16);
  const firstRange = context.executedQueries[0]?.timeRangeLabel ?? "Requested period";
  const connectors = [...new Set(context.executedQueries.map((query) => query.connector))];
  const connectorLabels: Partial<Record<string, string>> = {
    lightspeed: "Cube semantic layer · Lightspeed (POS)",
    deputy: "Cube semantic layer · Deputy (workforce)",
    xero: "Cube semantic layer · Xero (accounting)",
    shopify: "Official ShopifyQL live report",
  };
  const liveXeroStatement = context.executedQueries.some((query) => query.view.startsWith("xero-mcp:"));
  return {
    sources: connectors.map((connector) => ({
      connector,
      label: connector === "xero" && liveXeroStatement
        ? "Live Xero statement · official Xero MCP"
        : connectorLabels[connector] ?? `Cube semantic layer · ${connector}`,
      dataThrough: now,
    })),
    timeRange: {
      label: firstRange,
      start: "unknown",
      end: "unknown",
      timezone: context.config.timezone,
    },
    definitions: context.executedQueries.map((query) => ({
      metric: query.view.startsWith("shopifyql:")
        ? `shopifyql.ir:${query.view.slice("shopifyql:".length)}`
        : query.view.startsWith("shopify-admin:")
          ? `shopify-admin.ir:${query.view.slice("shopify-admin:".length)}`
          : `cube.yaml:${query.view}`,
      label: query.topic,
      definition: query.queryYaml,
    })),
    semanticBundleHash: `albert-v3-cube-${yamlDigest}`,
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
  };
}

export function groundedAnswerState(input: Readonly<{
  lane: Lane;
  requested: AnswerState;
  queriesExecuted: number;
  rowsSeen: number;
  /** An empty result window reached past a connector's sync watermark. */
  freshnessQualified?: boolean;
  /** Governed result sets from earlier turns this turn re-used as evidence. */
  reusedResults?: number;
  /** Governed semantic definitions selected and validated by the conceptual lane. */
  definitionEvidenceCount?: number;
  /** A recipe declared its empty result to be the answer (a verified true negative). */
  emptyResultIsAnswer?: boolean;
}>): AnswerState {
  let state = input.requested;
  // A prior turn's governed result re-used this turn is evidence: a subset,
  // re-sort or re-chart of it needs no new query to be grounded.
  const evidenceSets = input.queriesExecuted + (input.reusedResults ?? 0);
  if (evidenceSets === 0 && (state === "Verified" || state === "Exploratory")) {
    state = input.lane === "conceptual" && (input.definitionEvidenceCount ?? 0) > 0
      ? state
      : input.lane === "explain"
      ? "Exploratory"
      : input.lane === "represent" || input.lane === "meta"
        ? state
        : "Unavailable";
  }
  if (state === "Verified" && input.rowsSeen === 0 && laneRequiresQueryEvidence(input.lane) && (input.reusedResults ?? 0) === 0 && !input.emptyResultIsAnswer) state = "No data";
  // A "verified" emptiness reaching past the sync watermark overstates
  // certainty: the data may simply not have arrived yet.
  if (input.freshnessQualified && (state === "Verified" || state === "No data")) {
    state = "Qualified";
  }
  if (laneRequiresQueryEvidence(input.lane) && evidenceSets === 0) {
    return "Unavailable";
  }
  return state;
}

export function ownerFacingAnswerText(input: Readonly<{
  lane: Lane;
  draft: string;
  queriesExecuted: number;
  reusedResults?: number;
}>): string {
  if (laneRequiresQueryEvidence(input.lane) && input.queriesExecuted + (input.reusedResults ?? 0) === 0) {
    return ungroundedOwnerAnswer();
  }
  return input.draft;
}
