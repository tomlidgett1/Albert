"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type SVGProps } from "react";
import { AnimatePresence, animate, motion, useReducedMotion } from "framer-motion";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ThinkingOrb } from "thinking-orbs";
import {
  DEFAULT_AGENT_PREFERENCES,
  CLAUDE_HAIKU_4_5_MODEL_ID,
  describeChatFailure,
  isAnthropicModel,
  isXaiModel,
  normalizeAgentPreferences,
  type AgentRunPreferences,
  type AlbertModelId,
  type ReasoningEffort,
  type AnswerState,
  type TraceAnswerEvent,
  type TraceClarificationEvent,
  type TraceEvent,
  type TraceTableEvent,
} from "@/packages/shared/src";
import { swarmEmptyProvenance, swarmPlanSteps } from "@/services/swarm/src/parent-events";
import {
  SALES_DEEP_OWNER_QUESTION,
  SALES_DEEP_PREFERENCES,
} from "@/services/swarm/src/sales-deep";
import {
  getPublicSpecialistAgentDefinition,
  normalizeSpecialistAgentId,
  parseSpecialistAgentId,
  specialistAgentAllowedForRole,
  type SpecialistAgentId,
} from "@/packages/albert-v3/src/specialist-agents/registry";
import { createClient } from "@/utils/supabase/client";
import InsightsStyleTrace from "./components/InsightsStyleTrace";
import AdminWorkspace from "./components/AdminWorkspace";
import ConnectionsWorkspace, {
  buildSidebarSyncCommentary,
  collectWorkspaceSyncDomains,
  COMING_SOON_PROVIDERS,
  connectionIngestionIsPending,
  connectionSyncSummary,
  ConnectionSyncProgress,
  emptyConnectionsWorkspace,
  readinessStateLabels,
  workspaceSyncIsActive,
  type ConnectableProviderId,
  type ConnectionProviderId,
  type ConnectionsWorkspaceData,
} from "./components/ConnectionsWorkspace";
import DictationWaveform from "./components/DictationWaveform";
import KeyInsightsPanel from "./components/KeyInsightsPanel";
import { ModelRunControls } from "./components/ModelRunControls";
import { ConversationRuntimeTabs, type ConversationRuntimeTab } from "./components/conversation-runtime-tabs";
import { CollapsibleUserQuestion } from "./components/CollapsibleUserQuestion";
import RuntimeComparisonWorkspace from "./components/runtime-comparison-workspace";
import OrganizationWorkspace from "./components/OrganizationWorkspace";
import BusinessContextWorkspace from "./components/BusinessContextWorkspace";
import SemanticMemoryWorkspace from "./components/SemanticMemoryWorkspace";
import RawDebugger from "./components/RawDebugger";
import {
  createRawDebugRecorder,
  mergeRawDebugTurn,
  type RawDebugTurn,
} from "./lib/raw-debug";
import { useChatDictation } from "./lib/use-chat-dictation";
import {
  useVoiceSession,
  type VoiceTurnObserver,
} from "./lib/use-voice-session";
import TenantDeletionWorkspace, {
  parseTenantDeletionReceipt,
  type TenantDeletionReceipt,
} from "./components/TenantDeletionWorkspace";
import DashboardWorkspace from "./components/DashboardWorkspace";
import ProactiveWorkspace from "./components/ProactiveWorkspace";
import SwarmPanel, { SWARM_PANEL_DEFAULT_WIDTH } from "./components/SwarmPanel";
import RecommendedAnalysis from "./components/RecommendedAnalysis";
import {
  hydrateSwarmFromRun,
  startSwarmFleet,
  stopSwarmFleet,
  subscribeSwarmRun,
  swarmRunSnapshot,
  type SwarmAgentLiveState,
} from "./lib/swarm-run-controller";
import MyDataWorkspace from "./components/MyDataWorkspace";
import TestChartWorkspace from "./components/TestChartWorkspace";
import NewTestWorkspace from "./components/NewTestWorkspace";
import AgentsWorkspace from "./components/AgentsWorkspace";
import QueryLogsWorkspace from "./components/QueryLogsWorkspace";
import { deriveKeyInsights, latestInsightActivity } from "./components/key-insights";
import { reloadPublishedNivoChartDesign } from "./lib/nivo-chart-design-store";
import { latestReasoningSummary } from "./lib/reasoning-summary";
import styles from "./dash.module.css";
import traceStyles from "./components/insights-trace.module.css";

type IconName =
  | "search"
  | "panel"
  | "monitor"
  | "sun"
  | "moon"
  | "chat"
  | "connections"
  | "logs"
  | "spec"
  | "organization"
  | "logout"
  | "chevron"
  | "plus"
  | "arrowUp"
  | "close"
  | "sort"
  | "sidebarRight"
  | "microphone"
  | "terminal"
  | "pin"
  | "archive"
  | "settings"
  | "stop"
  | "calendar"
  | "chevronDown"
  | "leaf"
  | "sparkles"
  | "dashboard"
  | "database"
  | "agents"
  | "chart"
  | "list"
  | "radar"
  | "voice";

type ActiveItem =
  | "Chat"
  | "Agents"
  | "Proactive"
  | "Dashboard"
  | "My Data"
  | "Test chart"
  | "New test"
  | "Logs"
  | "Connections"
  | "Admin"
  | "BusinessContext"
  | "SemanticMemory"
  | "Organization"
  | "Deletion";

type Theme = "system" | "light" | "beige" | "sage" | "dark" | "green";

const codexStarterPrompts = Object.freeze([
  "Give me a candid health check across sales, customers, inventory and cash",
  "What changed most in the last 90 days, and what evidence explains it?",
  "Find one high-confidence opportunity I could test this month",
  "Challenge the assumptions I may be making about business performance",
  "Reconcile POS cash in with Xero receipts and explain every material gap with named evidence",
  "Prove whether margin compression is mix, discounting, cost or write-offs, not a blended average",
  "Find SKUs that look profitable on contribution but destroy cash through inventory days",
  "Isolate labour cost per sale-hour that is rising faster than the sales those hours produce",
  "Identify customers who look loyal on repeat rate while cohort LTV is collapsing",
  "Stress-test working capital if the top ten customers paid 14 days later",
  "Separate price, volume and new-customer effects inside headline growth",
  "Detect category or product cannibalisation hidden inside a growing total",
  "Explain why cash moved differently from profit last quarter, with the sales or journals that caused it",
  "Find inventory that is aged, still being reordered, and still being promoted",
  "Rank risks by expected cash impact, not by how alarming the metric looks",
  "Find the first assumption in my current run-rate that would break under scrutiny",
  "Separate seasonality from a genuine structural shift in demand",
  "Reconstruct the full economic story of the worst week and the best week",
  "Find contradictions between Xero aged receivables and customer outstanding in sales",
  "Detect roster hours that do not match the sales they were meant to cover",
  "Quantify how much best-seller status is volume theatre versus economic profit",
  "Find the weakest causal chain from staffing to conversion to collected cash",
  "Identify the concentration risk a sceptical CFO would refuse to ignore",
  "Show what the current numbers look like if I refuse to average away the tails",
]);

const CODEX_MODEL_IDS = Object.freeze([
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const satisfies readonly AlbertModelId[]);
const V3_MODEL_IDS = Object.freeze([
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "grok-4.6",
  CLAUDE_HAIKU_4_5_MODEL_ID,
] as const satisfies readonly AlbertModelId[]);
const CODEX_REASONING_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningEffort[]);
/** Codex quality preflight is on by default, with an explicit per-session off switch. */
const DEFAULT_CODEX_SOL_PLANNER = true;
/** OpenAI recommends Pro selectively; keep the independent mode opt-in. */
const DEFAULT_CODEX_PRO_MODE = false;

const themeOptions: Array<{ value: Theme; label: string; icon: IconName }> = [
  { value: "system", label: "System theme", icon: "monitor" },
  { value: "light", label: "Light theme", icon: "sun" },
  { value: "beige", label: "Beige theme", icon: "sparkles" },
  { value: "sage", label: "Sage theme", icon: "leaf" },
  { value: "dark", label: "Dark theme", icon: "moon" },
  { value: "green", label: "Green theme", icon: "leaf" },
];

const themeStorageKey = "albert-theme";

const themeListeners = new Set<() => void>();
let themeSnapshot: Theme = "system";

function isTheme(value: string | null): value is Theme {
  return value === "system"
    || value === "light"
    || value === "beige"
    || value === "sage"
    || value === "dark"
    || value === "green";
}

function getThemeSnapshot(): Theme {
  if (typeof window === "undefined") return themeSnapshot;

  try {
    const storedTheme = window.localStorage.getItem(themeStorageKey);
    if (isTheme(storedTheme)) themeSnapshot = storedTheme;
  } catch {
    // The in-memory preference remains available when browser storage is blocked.
  }

  return themeSnapshot;
}

function getServerThemeSnapshot(): Theme {
  return "system";
}

function subscribeToTheme(listener: () => void) {
  themeListeners.add(listener);
  const handleStorageChange = () => listener();
  window.addEventListener("storage", handleStorageChange);

  return () => {
    themeListeners.delete(listener);
    window.removeEventListener("storage", handleStorageChange);
  };
}

function setThemePreference(nextTheme: Theme) {
  themeSnapshot = nextTheme;

  try {
    window.localStorage.setItem(themeStorageKey, nextTheme);
  } catch {
    // The in-memory preference remains available when browser storage is blocked.
  }

  themeListeners.forEach((listener) => listener());
}

function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  const shared = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.9,
    viewBox: "0 0 24 24",
    "aria-hidden": true,
    ...props,
  };

  switch (name) {
    case "search":
      return <svg {...shared}><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></svg>;
    case "panel":
      return <svg {...shared}><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M12 4v16" /></svg>;
    case "monitor":
      return <svg {...shared}><rect x="3.5" y="5" width="17" height="11.5" rx="1.8" /><path d="M9 20h6M12 16.5V20" /></svg>;
    case "sun":
      return <svg {...shared}><circle cx="12" cy="12" r="3.5" /><path d="M12 2.8v2M12 19.2v2M21.2 12h-2M4.8 12h-2M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4M18.5 18.5l-1.4-1.4M6.9 6.9 5.5 5.5" /></svg>;
    case "moon":
      return <svg {...shared}><path d="M19.7 14.5A7.8 7.8 0 0 1 9.5 4.3a8 8 0 1 0 10.2 10.2Z" /></svg>;
    case "leaf":
      return <svg {...shared}><path d="M5 19c8 0 12-6 14-14-8 2-14 6-14 14Z" /><path d="M8 16c3-3 6-6 11-9" /></svg>;
    case "sparkles":
      return <svg {...shared}><path d="M12 3.5c.7 3.4 2.6 5.3 6 6-3.4.7-5.3 2.6-6 6-.7-3.4-2.6-5.3-6-6 3.4-.7 5.3-2.6 6-6Z" /><path d="M18.5 15.5c.3 1.5 1.2 2.4 2.7 2.7-1.5.3-2.4 1.2-2.7 2.7-.3-1.5-1.2-2.4-2.7-2.7 1.5-.3 2.4-1.2 2.7-2.7Z" /></svg>;
    case "chat":
      return <svg {...shared}><path d="M20.2 11.2c0 4.5-3.7 8.1-8.3 8.1a8.8 8.8 0 0 1-3.2-.6l-4.7 1.2 1.2-4.3a7.8 7.8 0 0 1-1.5-4.4c0-4.5 3.7-8.1 8.2-8.1s8.3 3.6 8.3 8.1Z" /></svg>;
    case "dashboard":
      return <svg {...shared}><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M3.5 10h17M10 10v10" /></svg>;
    case "database":
      return <svg {...shared}><ellipse cx="12" cy="5.5" rx="7.5" ry="3" /><path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" /></svg>;
    case "agents":
      return <svg {...shared}><circle cx="9" cy="8" r="3" /><path d="M3.8 19c.4-3.5 2.1-5.3 5.2-5.3s4.8 1.8 5.2 5.3" /><circle cx="17.2" cy="9" r="2.3" /><path d="M15.3 14.3c.6-.3 1.3-.4 2.1-.4 2.1 0 3.3 1.3 3.6 3.8" /></svg>;
    case "chart":
      return <svg {...shared}><path d="M4 19V5M4 19h16" /><path d="M8 15v-3M12 15V8M16 15v-6" /></svg>;
    case "list":
      return (
        <svg {...shared}>
          <path d="M9 6h11M9 12h11M9 18h11" />
          <circle cx="5" cy="6" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="5" cy="18" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "radar":
      return <svg {...shared}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.6" /><path d="M12 12l5.5-6.4" /><circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" /></svg>;
    case "connections":
      return <svg {...shared}><path d="M9.2 14.8 7.6 16.4a3.2 3.2 0 0 1-4.5-4.5l3.3-3.3a3.2 3.2 0 0 1 4.5 0" /><path d="m14.8 9.2 1.6-1.6a3.2 3.2 0 0 1 4.5 4.5l-3.3 3.3a3.2 3.2 0 0 1-4.5 0" /><path d="m8.5 15.5 7-7" /></svg>;
    case "logs":
      return <svg {...shared}><path d="m5 7 2-2h10l2 2" /><path d="m5 12 2-2h10l2 2" /><path d="m5 17 2-2h10l2 2" /></svg>;
    case "spec":
      return <svg {...shared}><path d="M6 3.5h7.5L19 9v11.5H6Z" /><path d="M13.5 3.5V9H19" /><path d="M9 13h7M9 16.5h5" /></svg>;
    case "organization":
      return <svg {...shared}><path d="M4 20V8.5l5-3v14.5M9 20h11M15 20V4h5v16" /><path d="M6.5 11h.1M6.5 14.5h.1M17.5 8h.1M17.5 11.5h.1M17.5 15h.1" /></svg>;
    case "logout":
      return <svg {...shared}><path d="M10 4.2H6.2a2 2 0 0 0-2 2v11.6a2 2 0 0 0 2 2H10" /><path d="M13 8.2 17 12l-4 3.8M17 12H8.3" /></svg>;
    case "chevron":
      return <svg {...shared}><path d="m9 5 7 7-7 7" /></svg>;
    case "plus":
      return <svg {...shared}><path d="M12 5v14M5 12h14" /></svg>;
    case "arrowUp":
      return <svg {...shared}><path d="M12 18V6M7.5 10.5 12 6l4.5 4.5" /></svg>;
    case "close":
      return <svg {...shared}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    case "sort":
      return <svg {...shared}><path d="M5 7h10M5 12h7M5 17h4" /></svg>;
    case "sidebarRight":
      return <svg {...shared}><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M14.5 4v16" /></svg>;
    case "terminal":
      return <svg {...shared}><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="m7.5 10 2.5 2-2.5 2M12.5 14h4" /></svg>;
    case "microphone":
      return <svg {...shared}><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5M9 20.5h6" /></svg>;
    case "voice":
      return <svg {...shared}><path d="M4 10.5v3M8 7.5v9M12 4.5v15M16 7.5v9M20 10.5v3" /></svg>;
    case "pin":
      return <svg {...shared}><path d="M12 17v5M9.5 3.5h5l1.5 6.5H18l-3.5 4v2h-5v-2L6 10h2Z" /></svg>;
    case "archive":
      return <svg {...shared}><path d="M4.5 7.5h15v12.5a1.5 1.5 0 0 1-1.5 1.5h-12a1.5 1.5 0 0 1-1.5-1.5Z" /><path d="M3.5 4.5h17v3h-17Z" /><path d="M10 12h4" /></svg>;
    case "settings":
      return (
        <svg {...shared}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
        </svg>
      );
    case "stop":
      return <svg {...shared}><rect x="7" y="7" width="10" height="10" rx="1.75" fill="currentColor" stroke="none" /></svg>;
    case "calendar":
      return (
        <svg {...shared}>
          <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
          <path d="M8 3.5v4M16 3.5v4M4 10h16" />
        </svg>
      );
    case "chevronDown":
      return <svg {...shared}><path d="m6 9 6 6 6-6" /></svg>;
    default:
      return null;
  }
}

type ChatRuntime = "fixture" | "openai" | "anthropic" | "cubecore" | "v3" | "xero_mcp" | "codex" | "compare";

function chatRuntimeFromProfile(value: unknown): Exclude<ChatRuntime, "fixture"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "openai";
  const profile = value as Record<string, unknown>;
  if (profile.runtime === "codex-app-server" || profile.analyticalRuntime === "cube-codex-v1") {
    return "codex";
  }
  if (profile.runtime === "xero-mcp" || profile.analyticalRuntime === "xero-mcp") {
    return "xero_mcp";
  }
  if (profile.runtime === "albert-v3" || profile.analyticalRuntime === "cube-v3") {
    return "v3";
  }
  if (profile.runtime === "cubecore-v1" || profile.analyticalRuntime === "cubecore") {
    return "cubecore";
  }
  if (profile.model === CLAUDE_HAIKU_4_5_MODEL_ID) {
    return "v3";
  }
  if (
    profile.runtime === "anthropic-agent-sdk"
    || (typeof profile.model === "string" && profile.model.startsWith("claude-"))
  ) {
    return "anthropic";
  }
  // History used to omit runtime. Grok is served by Albert v3; sending it to
  // the v1 OpenAI route trips the immutable runtime lock (HTTP 503).
  if (typeof profile.model === "string" && profile.model === "grok-4.6") {
    return "v3";
  }
  return "openai";
}

function specialistAgentIdFromProfile(value: unknown): SpecialistAgentId {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "general";
  return normalizeSpecialistAgentId((value as Record<string, unknown>).specialistAgentId);
}

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  isStreaming?: boolean;
  events?: TraceEvent[];
  runtime?: ChatRuntime;
  conversationId?: string;
  turnId?: string;
  suppressEnter?: boolean;
  animateReveal?: boolean;
  /** When false, hide thinking/answer trail until the user bubble has pinned. */
  trailVisible?: boolean;
};

function buildStoppedTraceEvent(
  assistantId: number,
  message: string,
  sequence: number,
): TraceEvent {
  return {
    id: `trace_stopped_${assistantId}_${sequence}`,
    sequence,
    type: "error",
    status: "error",
    occurredAt: new Date().toISOString(),
    message,
    recoverable: true,
  };
}

/** End any live-looking assistant rows. Used when leaving a chat or replacing a turn. */
function swarmAgentPhase(status: string): SwarmAgentLiveState["phase"] {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "stopped") return "stopped";
  if (status === "running") return "researching";
  return "pending";
}

function swarmAgentsFromPersisted(
  agents: readonly Readonly<{
    agentKey: string;
    title: string;
    tagline: string;
    role: string;
    status: string;
    headline: string | null;
    answerState: string | null;
    conversationId: string | null;
    turnId: string | null;
    failureNote: string | null;
  }>[],
): SwarmAgentLiveState[] {
  return agents.map((agent) => ({
    key: agent.agentKey,
    title: agent.title,
    tagline: agent.tagline,
    role: agent.role,
    phase: swarmAgentPhase(agent.status),
    statusLine: agent.headline
      ?? (agent.status === "failed"
        ? (agent.failureNote ?? "Failed")
        : agent.status === "running"
          ? "Working…"
          : "Queued"),
    queriesSeen: 0,
    headline: agent.headline,
    answerState: agent.answerState,
    conversationId: agent.conversationId,
    turnId: agent.turnId,
    error: agent.failureNote,
  }));
}

function finalizeStreamingMessages(
  messages: readonly ChatMessage[],
  message = "This analysis was interrupted.",
): ChatMessage[] {
  return messages.map((entry) => {
    if (entry.role !== "assistant" || !entry.isStreaming) return entry;
    const events = entry.events ?? [];
    const alreadyStopped = events.some((event) => (
      event.type === "error" && (event.message === "Stopped." || event.message === message)
    ));
    return {
      ...entry,
      isStreaming: false,
      events: alreadyStopped
        ? events
        : [...events, buildStoppedTraceEvent(entry.id, message, events.length + 1)],
    };
  });
}

type ChatClarification = {
  question: string;
  options: [string, string];
};

/** Strip to AU mobile national digits (9 digits after country / leading 0), starting with 4. */
function normalizeAuMobileDigits(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("61")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return digits.slice(0, 9);
}

/** Format national AU mobile digits with +61 prefix UI: 4XX XXX XXX. */
function formatAuMobileDisplay(raw: string): string {
  const digits = normalizeAuMobileDigits(raw);
  if (!digits) return "";
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

function isValidAuMobile(raw: string): boolean {
  const digits = normalizeAuMobileDigits(raw);
  return digits.length === 9 && digits.startsWith("4");
}

type ConversationSummary = Readonly<{
  conversationId: string;
  title: string;
  /** True when the control-plane has not stored an AI title yet. */
  titlePending: boolean;
  status: string;
  updatedAt: string;
  lastMessage: string;
  lastTurnStatus?: string;
  runtime: Exclude<ChatRuntime, "fixture">;
  specialistAgentId: SpecialistAgentId;
}>;

type OAuthNotice = Readonly<{
  kind: "success" | "info" | "error";
  message: string;
  detail?: string;
}>;

const oauthProviderLabels: Readonly<Record<ConnectableProviderId, string>> = Object.freeze({
  lightspeed: "Lightspeed",
  "lightspeed-x": "Lightspeed X-Series",
  xero: "Xero",
  "fivetran-xero": "Xero (Fivetran)",
  "fivetran-lightspeed": "Lightspeed (Fivetran)",
  "fivetran-deputy": "Deputy (Fivetran)",
  "fivetran-stripe": "Stripe (Fivetran)",
  deputy: "Deputy",
  square: "Square",
  shopify: "Shopify",
  stripe: "Stripe",
  momence: "Momence",
  "meta-ads": "Meta Ads",
  "google-ads": "Google Ads",
});

function isConnectableProviderId(value: string | null | undefined): value is ConnectableProviderId {
  return typeof value === "string" &&
    ["lightspeed", "lightspeed-x", "xero", "fivetran-xero", "fivetran-lightspeed", "deputy", "fivetran-deputy", "fivetran-stripe", "square", "shopify", "stripe", "momence", "meta-ads", "google-ads"]
      .includes(value);
}

function withComingSoonProviders(
  workspace: ConnectionsWorkspaceData,
): ConnectionsWorkspaceData {
  const existing = new Set(workspace.providers.map((provider) => provider.id));
  const missing = COMING_SOON_PROVIDERS.filter((provider) => !existing.has(provider.id));
  if (missing.length === 0) return workspace;
  return {
    ...workspace,
    providers: [...workspace.providers, ...missing],
  };
}

function oauthNoticeFrom(searchParams: URLSearchParams): OAuthNotice | null {
  const status = searchParams.get("oauth");
  if (!status) return null;
  const rawProvider = searchParams.get("provider");
  const provider = isConnectableProviderId(rawProvider)
    ? oauthProviderLabels[rawProvider]
    : "This source";
  const detail = searchParams.get("oauth_detail")?.trim() || undefined;

  switch (status) {
    case "connected":
      return { kind: "success", message: `${provider} is connected. The recent-first sync has started.` };
    case "connected_without_sync":
      return {
        kind: "success",
        message: `${provider} is connected. Data will not be ingested until you choose Start ingestion.`,
      };
    case "selection_required":
      return { kind: "info", message: `Choose the ${provider} account below to finish connecting it.` };
    case "cancelled":
      return { kind: "info", message: `${provider} authorization was cancelled. Nothing was changed.` };
    case "rate_limited":
      return { kind: "error", message: "Too many authorization attempts were made. Wait a few minutes, then try again." };
    case "invalid_callback":
      return { kind: "error", message: `${provider} returned an invalid or expired authorization response. Start the connection again.` };
    case "tenant_missing":
      return { kind: "error", message: "Choose or create an organisation before connecting a source." };
    case "unknown_provider":
      return { kind: "error", message: "That connection provider is not supported." };
    case "setup_incomplete":
      return {
        kind: "info",
        message: `${provider} was not finished. Choose Connect again, then on the secure connection page click Authorize, sign in to Xero, pick your organisation, and press Save & Test.`,
        detail,
      };
    case "start_failed":
      return {
        kind: "error",
        message: /stripe/i.test(provider) && /STRIPE_|oauth_provider_not_configured/u.test(detail ?? "")
          ? "Stripe (Fivetran) needs the Stripe Connect app keys on the sync worker before Connect will open Stripe."
          : `${provider} could not be started right now. Try again in a moment; if it keeps happening, the connection may not be set up for this workspace yet.`,
        detail,
      };
    default:
      return {
        kind: "error",
        message: /stripe/i.test(provider) && /fivetran_stripe_live_key_required|test-mode key/u.test(detail ?? "")
          ? "Stripe (Fivetran) needs a live Stripe account. Test-mode keys cannot land the official ERD."
          : /stripe/i.test(provider) && /fivetran_stripe_token_missing|secret or Restricted key/u.test(detail ?? "")
          ? "Stripe Connect did not return a key Fivetran can use. Reconnect after confirming the Connect app still issues a secret or Restricted key."
          : `${provider} authorization could not be completed. Try connecting again.`,
        detail,
      };
  }
}

const traceEventTypes = new Set([
  "progress",
  "narrative",
  "plan",
  "query",
  "table",
  "chart",
  "validation",
  "answer",
  "clarification",
  "error",
]);
const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

function parseTraceEvent(value: unknown): TraceEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string"
    || typeof candidate.sequence !== "number"
    || typeof candidate.type !== "string"
    || !traceEventTypes.has(candidate.type)
    || typeof candidate.occurredAt !== "string"
  ) {
    return null;
  }
  return candidate as unknown as TraceEvent;
}

function parseConnectionsWorkspace(value: unknown): ConnectionsWorkspaceData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.tenantName !== "string" ||
    typeof candidate.timezone !== "string" ||
    !candidate.syncSummary ||
    !Array.isArray(candidate.providers) ||
    !Array.isArray(candidate.dossier) ||
    !Array.isArray(candidate.blockingQuestions) ||
    !Array.isArray(candidate.identityMatches)
  ) {
    return null;
  }
  return candidate as unknown as ConnectionsWorkspaceData;
}

function parseConversationSummaries(value: unknown): readonly ConversationSummary[] | null {
  if (!Array.isArray(value)) return null;
  const summaries: ConversationSummary[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const candidate = item as Record<string, unknown>;
    const lastTurn = candidate.last_turn;
    if (
      typeof candidate.conversation_id !== "string"
      || !ulidPattern.test(candidate.conversation_id)
      || typeof candidate.status !== "string"
      || typeof candidate.updated_at !== "string"
      || (candidate.title !== null && typeof candidate.title !== "string")
      || (lastTurn !== null && (typeof lastTurn !== "object" || Array.isArray(lastTurn)))
    ) return null;
    const lastTurnRecord = lastTurn && typeof lastTurn === "object" && !Array.isArray(lastTurn)
      ? lastTurn as Record<string, unknown>
      : null;
    const lastMessage = lastTurnRecord && typeof lastTurnRecord.user_message === "string"
      ? String(lastTurnRecord.user_message)
      : "New conversation";
    const lastTurnStatus = lastTurnRecord && typeof lastTurnRecord.status === "string"
      ? lastTurnRecord.status
      : undefined;
    const runtime = chatRuntimeFromProfile(lastTurnRecord?.runtime_profile);
    const specialistAgentId = specialistAgentIdFromProfile(lastTurnRecord?.runtime_profile);
    const storedTitle = typeof candidate.title === "string" ? candidate.title.trim() : "";
    summaries.push({
      conversationId: candidate.conversation_id,
      title: formatConversationTitle(storedTitle || lastMessage),
      titlePending: !storedTitle,
      status: candidate.status,
      updatedAt: candidate.updated_at,
      lastMessage,
      lastTurnStatus,
      runtime,
      specialistAgentId,
    });
  }
  return summaries;
}

function relativeConversationTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const diffMs = Date.now() - date.valueOf();
  if (diffMs < 45_000) return "now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatConversationTitle(value: string, maxLength = 80): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return capitalised.slice(0, maxLength);
}

function isSameCalendarDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/** Local calendar day key for sorting sections (newest first). */
function conversationDayKey(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.valueOf())) return "0000-00-00";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function conversationDayLabel(updatedAt: string, now = new Date()): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.valueOf())) return "Earlier";
  if (isSameCalendarDay(date, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return "Yesterday";
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

type ConversationSidebarPrefs = Readonly<{
  archivedIds: readonly string[];
  pinnedIds: readonly string[];
}>;

const emptyConversationSidebarPrefs: ConversationSidebarPrefs = Object.freeze({
  archivedIds: [],
  pinnedIds: [],
});

function conversationSidebarPrefsKey(email: string): string {
  return `albert:conversation-sidebar-prefs:v1:${email.trim().toLowerCase() || "anon"}`;
}

function loadConversationSidebarPrefs(email: string): ConversationSidebarPrefs {
  if (typeof window === "undefined") return emptyConversationSidebarPrefs;
  try {
    const raw = window.localStorage.getItem(conversationSidebarPrefsKey(email));
    if (!raw) return emptyConversationSidebarPrefs;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const archivedIds = Array.isArray(parsed.archivedIds)
      ? parsed.archivedIds.filter((id): id is string => typeof id === "string" && ulidPattern.test(id))
      : [];
    const pinnedIds = Array.isArray(parsed.pinnedIds)
      ? parsed.pinnedIds.filter((id): id is string => typeof id === "string" && ulidPattern.test(id))
      : [];
    return { archivedIds, pinnedIds };
  } catch {
    return emptyConversationSidebarPrefs;
  }
}

function saveConversationSidebarPrefs(email: string, prefs: ConversationSidebarPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(conversationSidebarPrefsKey(email), JSON.stringify({
      archivedIds: prefs.archivedIds,
      pinnedIds: prefs.pinnedIds,
    }));
  } catch {
    // Ignore private-mode storage failures.
  }
}

export default function DashPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [accountEmail, setAccountEmail] = useState("");
  const [accountOrganisation, setAccountOrganisation] = useState<{
    name: string;
    role: "owner" | "manager" | "bookkeeper" | "internal_operator" | null;
  }>({ name: "Organisation", role: null });
  const [isInternalOperator, setIsInternalOperator] = useState(false);
  const [canViewQueryLogs, setCanViewQueryLogs] = useState(false);
  const [oauthNotice, setOAuthNotice] = useState<OAuthNotice | null>(null);
  const [connectionsData, setConnectionsData] = useState<ConnectionsWorkspaceData>(emptyConnectionsWorkspace);
  const [connectionsStatus, setConnectionsStatus] = useState<{
    kind: "loading" | "error" | "ready";
    message?: string;
  }>({ kind: "loading" });
  const [tenantDeletionReceipt, setTenantDeletionReceipt] = useState<TenantDeletionReceipt | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [activeItem, setActiveItem] = useState<ActiveItem>("Chat");
  const dashboardRevisionRef = useRef<number | null>(null);
  const theme = useSyncExternalStore(
    subscribeToTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [collapseIconSwapArmed, setCollapseIconSwapArmed] = useState(false);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const collapseSwapArmTimerRef = useRef<number | undefined>(undefined);
  const collapseSwapArmPendingRef = useRef(false);
  const [sidebarNavRevealed, setSidebarNavRevealed] = useState(true);
  const sidebarWasCollapsedRef = useRef(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>();
  const [activeChatRuntime, setActiveChatRuntime] = useState<Exclude<ChatRuntime, "fixture">>("codex");
  const [specialistAgentId, setSpecialistAgentId] = useState<SpecialistAgentId>("general");
  const [agentPreferences, setAgentPreferences] = useState<AgentRunPreferences>(DEFAULT_AGENT_PREFERENCES);
  const [codexSolPlannerEnabled, setCodexSolPlannerEnabled] = useState(DEFAULT_CODEX_SOL_PLANNER);
  const [codexProModeEnabled, setCodexProModeEnabled] = useState(DEFAULT_CODEX_PRO_MODE);
  const [isChatResponding, setIsChatResponding] = useState(false);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [chatDetailedMode, setChatDetailedMode] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("albert:chat:detailed-mode") === "true";
    } catch {
      return false;
    }
  });
  const [takeawaysOpen, setTakeawaysOpen] = useState(false);
  const [reasoningPanelOpen, setReasoningPanelOpen] = useState(false);
  const [swarmEnabled, setSwarmEnabled] = useState(false);
  const [swarmPanelOpen, setSwarmPanelOpen] = useState(false);
  const [swarmPanelWidth, setSwarmPanelWidth] = useState(SWARM_PANEL_DEFAULT_WIDTH);
  const [swarmPanelResizing, setSwarmPanelResizing] = useState(false);
  const [swarmConversationIds, setSwarmConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const swarmEnabledRef = useRef(false);
  const setSwarmMode = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(swarmEnabledRef.current) : next;
    // Send routing reads the ref synchronously. Updating both here prevents a
    // click-and-send in the same event loop from rendering Swarm as selected
    // while still posting an ordinary /api/codex-conversation turn.
    swarmEnabledRef.current = resolved;
    setSwarmEnabled(resolved);
  }, []);
  const swarmSnapshot = useSyncExternalStore(subscribeSwarmRun, swarmRunSnapshot, swarmRunSnapshot);
  const [codexPromptsOpen, setCodexPromptsOpen] = useState(false);
  const codexPromptMenuId = useId();
  const codexPromptMenuRef = useRef<HTMLDivElement>(null);
  const codexPromptTriggerRef = useRef<HTMLButtonElement>(null);
  // Development inspector. Always available, including production, while the
  // product is in dogfood; it only shows what this client already received.
  const rawDebugAvailable = true;
  const [rawDebugOpen, setRawDebugOpen] = useState(false);
  const [rawDebugTurns, setRawDebugTurns] = useState<readonly RawDebugTurn[]>([]);
  // Record whenever the inspector is available, not only while it is open, so
  // opening it after a surprising turn still shows that turn.
  const rawDebugOnRef = useRef(false);
  rawDebugOnRef.current = rawDebugAvailable;

  useEffect(() => {
    try {
      window.localStorage.setItem("albert:chat:detailed-mode", chatDetailedMode ? "true" : "false");
    } catch {
      // Ignore private-mode storage failures.
    }
  }, [chatDetailedMode]);
  useEffect(() => {
    void reloadPublishedNivoChartDesign();
  }, []);
  const [conversationSummaries, setConversationSummaries] = useState<readonly ConversationSummary[]>([]);
  const seenSidebarConversationIdsRef = useRef<Set<string>>(new Set());
  const [computingConversationIds, setComputingConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [unreadConversationIds, setUnreadConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const computingTokensRef = useRef(new Map<string, symbol>());
  const activeItemRef = useRef(activeItem);
  activeItemRef.current = activeItem;
  const [conversationSidebarPrefs, setConversationSidebarPrefs] = useState<ConversationSidebarPrefs>(
    emptyConversationSidebarPrefs,
  );
  const [conversationHistoryStatus, setConversationHistoryStatus] = useState<{
    kind: "idle" | "loading" | "ready" | "error";
    message?: string;
  }>({ kind: "idle" });
  const [chatClarification, setChatClarification] = useState<ChatClarification | null>(null);
  const [clarifyDraft, setClarifyDraft] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [editClosingId, setEditClosingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editPanelOpen, setEditPanelOpen] = useState(false);
  const editCloseTimerRef = useRef<number | undefined>(undefined);
  const [editResendConfirm, setEditResendConfirm] = useState<null | {
    messageId: number;
    messageIndex: number;
    text: string;
    conversationId?: string;
    fromTurnId?: string;
  }>(null);
  const [editResendConfirmClosing, setEditResendConfirmClosing] = useState(false);
  const [editResendBusy, setEditResendBusy] = useState(false);
  const editResendConfirmCloseTimerRef = useRef<number | undefined>(undefined);
  const [collapsedConversationGroups, setCollapsedConversationGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerMultiline, setComposerMultiline] = useState(false);
  const dictation = useChatDictation();
  // Live speech mode: the realtime voice fronts the same governed codex turn
  // the composer sends, so spoken questions land in the visible chat thread.
  const voice = useVoiceSession({
    runAnalysis: (question, observer) => {
      const current = agentPreferencesRef.current;
      void sendChatMessage(question, undefined, {
        allowWhileResponding: true,
        forceRuntime: "codex",
        // A spoken wait hurts far more than a read one: voice runs the fast
        // profile (low effort + fast mode) instead of the selector's depth,
        // and falls back to a codex-capable model if another runtime's model
        // is selected.
        preferencesOverride: {
          model: (CODEX_MODEL_IDS as readonly string[]).includes(current.model)
            ? current.model
            : "gpt-5.6-luna",
          reasoningEffort: "low",
          fastMode: true,
        },
        observer,
      });
    },
  });
  const [mobileConnectOpen, setMobileConnectOpen] = useState(false);
  const [mobileConnectClosing, setMobileConnectClosing] = useState(false);
  const [mobileNumber, setMobileNumber] = useState("");
  const reduceMotion = useReducedMotion();
  const mobileConnectCloseTimerRef = useRef<number | undefined>(undefined);
  const mobileNumberInputRef = useRef<HTMLInputElement>(null);
  const accountAreaRef = useRef<HTMLDivElement>(null);
  const accountPopoverRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const accountPreviousFocusRef = useRef<HTMLElement | null>(null);
  const agentsAreaRef = useRef<HTMLDivElement>(null);
  const agentsPopoverRef = useRef<HTMLDivElement>(null);
  const agentsTriggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const chatWorkspaceRef = useRef<HTMLDivElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const chatSpacerRef = useRef<HTMLDivElement>(null);
  const chatComposerRef = useRef<HTMLFormElement>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editComposerRef = useRef<HTMLDivElement>(null);
  const editResendConfirmButtonRef = useRef<HTMLButtonElement>(null);
  const confirmEditedMessageResendRef = useRef<() => Promise<void>>(async () => {});
  const lastPinnedUserMessageIdRef = useRef<number | null>(null);
  const composerOriginTopRef = useRef<number | null>(null);
  const shouldAnimatePinRef = useRef(false);
  const chatPinAnimationsRef = useRef<Array<{ stop: () => void }>>([]);
  const chatPinTimerRef = useRef<number | undefined>(undefined);
  const composerExpandTimerRef = useRef<number | undefined>(undefined);
  /** In-flight turns keyed by conversation id (or draft:* before the id exists). */
  const liveTurnsRef = useRef(new Map<string, {
    controller: AbortController;
    assistantId: number;
    preferences: AgentRunPreferences;
    runtime: Exclude<ChatRuntime, "fixture">;
    specialistAgentId: SpecialistAgentId;
    turnId?: string;
  }>());
  const activeConversationIdRef = useRef<string | undefined>(undefined);
  const activeChatRuntimeRef = useRef<Exclude<ChatRuntime, "fixture">>("codex");
  const specialistAgentIdRef = useRef<SpecialistAgentId>("general");
  const viewingKeyRef = useRef<string | null>(null);
  const agentPreferencesRef = useRef(agentPreferences);
  agentPreferencesRef.current = agentPreferences;
  const codexSolPlannerEnabledRef = useRef(codexSolPlannerEnabled);
  codexSolPlannerEnabledRef.current = codexSolPlannerEnabled;
  const codexProModeEnabledRef = useRef(codexProModeEnabled);
  codexProModeEnabledRef.current = codexProModeEnabled;
  const openConversationAbortRef = useRef<AbortController | null>(null);
  const openConversationRequestIdRef = useRef(0);
  const conversationCacheRef = useRef(new Map<string, {
    messages: ChatMessage[];
    preferences: AgentRunPreferences;
    messageSequence: number;
    runtime: Exclude<ChatRuntime, "fixture">;
    specialistAgentId: SpecialistAgentId;
  }>());

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
    viewingKeyRef.current = activeConversationId ?? viewingKeyRef.current;
  }, [activeConversationId]);
  useEffect(() => {
    activeChatRuntimeRef.current = activeChatRuntime;
  }, [activeChatRuntime]);
  useEffect(() => {
    specialistAgentIdRef.current = specialistAgentId;
  }, [specialistAgentId]);
  const [openingConversationId, setOpeningConversationId] = useState<string | null>(null);
  const [conversationSkelPhase, setConversationSkelPhase] = useState<"idle" | "loading" | "revealing">("idle");
  const [conversationSkelRevealed, setConversationSkelRevealed] = useState(false);
  const [conversationSkelResetting, setConversationSkelResetting] = useState(false);
  const conversationSkelPhaseRef = useRef<"idle" | "loading" | "revealing">("idle");
  const openingConversationIdRef = useRef<string | null>(null);
  const conversationSkelHostRef = useRef<HTMLDivElement>(null);
  const chatMessageSequenceRef = useRef(0);
  conversationSkelPhaseRef.current = conversationSkelPhase;
  openingConversationIdRef.current = openingConversationId;
  // Keep the composer docked while history loads or reveals. Hero/compact chrome
  // would lift the input into the middle of the page behind the skeleton.
  const conversationSkelActive = conversationSkelPhase !== "idle";
  const chatComposerHero = activeItem === "Chat"
    && chatMessages.length === 0
    && !openingConversationId
    && !conversationSkelActive;
  const keyInsightTurns = chatMessages
    .filter((message) => message.role === "assistant")
    .map((message) => ({
      id: message.id,
      events: message.events ?? [],
      streaming: Boolean(message.isStreaming),
    }));
  const keyInsights = deriveKeyInsights(keyInsightTurns);
  const keyInsightsStreaming = keyInsightTurns.some((turn) => turn.streaming);
  const keyInsightActivity = latestInsightActivity(keyInsightTurns);
  const reasoningTurns = chatMessages.flatMap((message, index) => {
    if (message.role !== "assistant" || message.runtime !== "codex") return [];
    const summary = latestReasoningSummary(message.events ?? []);
    const question = [...chatMessages.slice(0, index)]
      .reverse()
      .find((candidate) => candidate.role === "user")?.text.trim() ?? "";
    if (!summary && !message.isStreaming) return [];
    return [{
      id: message.id,
      question,
      summary,
      streaming: Boolean(message.isStreaming),
    }];
  });
  const sidePanelOpen = takeawaysOpen || reasoningPanelOpen || swarmPanelOpen;
  const chatBusy = isChatResponding
    || (
      swarmSnapshot.active
      && Boolean(swarmSnapshot.parentConversationId)
      && swarmSnapshot.parentConversationId === (activeConversationId ?? null)
    );
  // Empty "New Analysis" keeps the Ask-me-anything title, but uses the same
  // compact input height as an active conversation. Tall hero sizing only runs
  // briefly after the first send while the docked transition finishes.
  const showHeroComposer = activeItem === "Chat"
    && chatMessages.length > 0
    && !composerExpanded
    && !openingConversationId
    && !conversationSkelActive;
  useEffect(() => {
    if (chatComposerHero && activeChatRuntime === "codex") return;
    setCodexPromptsOpen(false);
  }, [activeChatRuntime, chatComposerHero]);
  useEffect(() => {
    if (!codexPromptsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (codexPromptMenuRef.current?.contains(event.target as Node)) return;
      setCodexPromptsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setCodexPromptsOpen(false);
      codexPromptTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [codexPromptsOpen]);
  const resizeComposerTextarea = useCallback(() => {
    const textarea = chatTextareaRef.current;
    if (!textarea) return;
    const singleLineHeight = showHeroComposer ? 34 : 28;
    const maxHeight = 168;
    textarea.style.height = "0px";
    const contentHeight = textarea.scrollHeight;
    const nextHeight = Math.min(Math.max(contentHeight, singleLineHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    // Prefer real wrapping / newlines over scrollHeight noise so the empty
    // single-line field does not pick up multiline layout metrics.
    const hasNewline = textarea.value.includes("\n");
    setComposerMultiline(hasNewline || contentHeight > singleLineHeight + 4);
  }, [showHeroComposer]);

  useLayoutEffect(() => {
    resizeComposerTextarea();
  }, [chatDraft, showHeroComposer, composerMultiline, resizeComposerTextarea]);

  const previousDictationStatusRef = useRef(dictation.status);
  useEffect(() => {
    const previous = previousDictationStatusRef.current;
    previousDictationStatusRef.current = dictation.status;
    if (dictation.status !== "idle" || previous === "idle") return;
    window.requestAnimationFrame(() => {
      resizeComposerTextarea();
      chatTextareaRef.current?.focus();
    });
  }, [dictation.status, resizeComposerTextarea]);

  const closeMobileConnect = useCallback(() => {
    if (!mobileConnectOpen || mobileConnectClosing) return;
    if (reduceMotion) {
      setMobileConnectOpen(false);
      setMobileConnectClosing(false);
      return;
    }
    setMobileConnectClosing(true);
    window.clearTimeout(mobileConnectCloseTimerRef.current);
    mobileConnectCloseTimerRef.current = window.setTimeout(() => {
      setMobileConnectOpen(false);
      setMobileConnectClosing(false);
    }, 180);
  }, [mobileConnectClosing, mobileConnectOpen, reduceMotion]);

  const openMobileConnect = useCallback(() => {
    window.clearTimeout(mobileConnectCloseTimerRef.current);
    setMobileConnectClosing(false);
    setMobileConnectOpen(true);
  }, []);

  useEffect(() => () => {
    window.clearTimeout(mobileConnectCloseTimerRef.current);
  }, []);

  useEffect(() => {
    if (!mobileConnectOpen || mobileConnectClosing) return;
    const frame = window.requestAnimationFrame(() => {
      mobileNumberInputRef.current?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobileConnect();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [closeMobileConnect, mobileConnectClosing, mobileConnectOpen]);

  const canManageConnections = accountOrganisation.role === "owner" || accountOrganisation.role === "manager";
  const canUseCustomerAgent = specialistAgentAllowedForRole("customers", accountOrganisation.role)
    || isInternalOperator;
  const activeSpecialistAgent = getPublicSpecialistAgentDefinition(specialistAgentId);
  const customerSpecialistAgent = getPublicSpecialistAgentDefinition("customers");
  const isCustomerAgent = specialistAgentId === "customers";
  const accountInitial = accountEmail.trim().charAt(0).toUpperCase() || "P";
  const accountRoleLabel = accountOrganisation.role
    ? accountOrganisation.role
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
    : "Loading organisation";
  const archivedConversationIds = useMemo(
    () => new Set(conversationSidebarPrefs.archivedIds),
    [conversationSidebarPrefs.archivedIds],
  );
  const [proactiveConversationIds, setProactiveConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  useEffect(() => {
    // Keep proactive research conversations out of sidebar history even before
    // the Proactive tab is opened; the workspace refreshes this set afterwards.
    let cancelled = false;
    void fetch("/api/proactive", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (cancelled || !payload || typeof payload !== "object") return;
        const ids = (payload as { conversationIds?: unknown }).conversationIds;
        if (!Array.isArray(ids)) return;
        setProactiveConversationIds(new Set(
          ids.filter((id): id is string => typeof id === "string"),
        ));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/swarm", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (cancelled || !payload || typeof payload !== "object") return;
        const ids = (payload as { conversationIds?: unknown }).conversationIds;
        if (!Array.isArray(ids)) return;
        setSwarmConversationIds(new Set(
          ids.filter((id): id is string => typeof id === "string"),
        ));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [swarmSnapshot.settledCount, swarmSnapshot.runId]);
  useEffect(() => {
    const ids = swarmSnapshot.agents
      .map((agent) => agent.conversationId)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    setSwarmConversationIds((current) => {
      const next = new Set(current);
      let changed = false;
      for (const id of ids) {
        if (next.has(id)) continue;
        next.add(id);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [swarmSnapshot.agents]);
  const pinnedConversationIds = useMemo(
    () => conversationSidebarPrefs.pinnedIds,
    [conversationSidebarPrefs.pinnedIds],
  );
  const pinnedConversationIdSet = useMemo(
    () => new Set(pinnedConversationIds),
    [pinnedConversationIds],
  );
  const filteredConversations = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return conversationSummaries.filter((conversation) => {
      if (archivedConversationIds.has(conversation.conversationId)) return false;
      // Proactive research conversations live in the control panel, not history.
      if (proactiveConversationIds.has(conversation.conversationId)) return false;
      if (swarmConversationIds.has(conversation.conversationId)) return false;
      if (!needle) return true;
      return conversation.title.toLowerCase().includes(needle)
        || conversation.lastMessage.toLowerCase().includes(needle)
        || conversation.status.toLowerCase().includes(needle);
    });
  }, [archivedConversationIds, conversationSummaries, proactiveConversationIds, query, swarmConversationIds]);
  const conversationGroups = useMemo(() => {
    const byId = new Map(
      filteredConversations.map((conversation) => [conversation.conversationId, conversation]),
    );
    const pinnedItems = pinnedConversationIds
      .map((id) => byId.get(id))
      .filter((conversation): conversation is ConversationSummary => Boolean(conversation));
    const unpinned = filteredConversations.filter(
      (conversation) => !pinnedConversationIdSet.has(conversation.conversationId),
    );
    const groups: Array<{
      key: string;
      label: string;
      kind: "pinned" | "day";
      items: ConversationSummary[];
    }> = [];
    if (pinnedItems.length > 0) {
      groups.push({ key: "pinned", label: "Pinned", kind: "pinned", items: pinnedItems });
    }
    const dayBuckets = new Map<string, ConversationSummary[]>();
    for (const conversation of unpinned) {
      const key = conversationDayKey(conversation.updatedAt);
      const existing = dayBuckets.get(key);
      if (existing) existing.push(conversation);
      else dayBuckets.set(key, [conversation]);
    }
    const dayKeys = [...dayBuckets.keys()].sort((left, right) => right.localeCompare(left));
    for (const key of dayKeys) {
      const items = dayBuckets.get(key) ?? [];
      const label = conversationDayLabel(items[0]?.updatedAt ?? `${key}T12:00:00`);
      groups.push({ key: `day:${key}`, label, kind: "day", items });
    }
    return groups;
  }, [filteredConversations, pinnedConversationIdSet, pinnedConversationIds]);
  const showRecommendedHome = chatComposerHero
    && !isCustomerAgent
    && conversationSummaries.some((conversation) => (
      !archivedConversationIds.has(conversation.conversationId)
      && !proactiveConversationIds.has(conversation.conversationId)
      && !swarmConversationIds.has(conversation.conversationId)
    ));
  const chatTitle = useMemo(() => {
    if (activeConversationId) {
      const match = conversationSummaries.find((item) => item.conversationId === activeConversationId);
      if (match?.title) return formatConversationTitle(match.title);
    }
    const firstUser = chatMessages.find((message) => message.role === "user" && message.text.trim());
    if (firstUser?.text) return formatConversationTitle(firstUser.text);
    return "New Analysis";
  }, [activeConversationId, chatMessages, conversationSummaries]);

  useEffect(() => {
    let isMounted = true;

    void supabase.auth.getUser().then(({ data }) => {
      if (isMounted) setAccountEmail(data.user?.email ?? "");
    });

    return () => {
      isMounted = false;
    };
  }, [supabase]);

  useEffect(() => {
    setConversationSidebarPrefs(loadConversationSidebarPrefs(accountEmail));
  }, [accountEmail]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const requestedView = url.searchParams.get("view");
    const nextOAuthNotice = oauthNoticeFrom(url.searchParams);
    if (url.searchParams.has("oauth") || url.searchParams.has("provider") || url.searchParams.has("oauth_detail")) {
      url.searchParams.delete("oauth");
      url.searchParams.delete("provider");
      url.searchParams.delete("oauth_detail");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (
      requestedView !== "Connections"
      && requestedView !== "MyData"
      && requestedView !== "TestChart"
      && requestedView !== "NewTest"
      && requestedView !== "Proactive"
      && requestedView !== "Agents"
      && !nextOAuthNotice
    ) return;
    if (requestedView === "NewTest") setActiveItem("New test");
    const task = window.setTimeout(() => {
      if (requestedView === "MyData") setActiveItem("My Data");
      else if (requestedView === "TestChart") setActiveItem("Test chart");
      else if (requestedView === "NewTest") setActiveItem("New test");
      else if (requestedView === "Proactive") setActiveItem("Proactive");
      else if (requestedView === "Agents") setActiveItem("Agents");
      else if (requestedView === "Connections" || nextOAuthNotice) setActiveItem("Connections");
      setOAuthNotice(nextOAuthNotice);
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setSidebarSearchOpen(true);
      if (collapsed) {
        setCollapsed(false);
        window.requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }
      searchInputRef.current?.focus();
    };

    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, [collapsed]);

  useEffect(() => {
    if (swarmPanelOpen) return;
    setSwarmPanelWidth(SWARM_PANEL_DEFAULT_WIDTH);
    setSwarmPanelResizing(false);
  }, [swarmPanelOpen]);

  useEffect(() => {
    if (collapsed) {
      sidebarWasCollapsedRef.current = true;
      setSidebarNavRevealed(false);
      return;
    }
    if (!sidebarWasCollapsedRef.current) {
      setSidebarNavRevealed(true);
      return;
    }
    sidebarWasCollapsedRef.current = false;
    if (reduceMotion) {
      setSidebarNavRevealed(true);
      return;
    }
    // Reveal on the next frame so opacity/transform animate in parallel with
    // the width open (same pattern as Key Insights).
    const frame = window.requestAnimationFrame(() => {
      setSidebarNavRevealed(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [collapsed, reduceMotion]);

  const loadConnections = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setConnectionsStatus({ kind: "loading" });
    try {
      const sessionResponse = await fetch("/api/session", { cache: "no-store" });
      const sessionPayload = await sessionResponse.json() as {
        error?: string;
        needsBootstrap?: boolean;
        internalOperator?: boolean;
        queryLogsViewer?: boolean;
        deletionReceipt?: unknown;
        user?: {
          email?: string | null;
          suggestedOrganisationName?: string | null;
          timezone?: string | null;
        };
        context?: {
          tenant_name?: string;
          role?: "owner" | "manager" | "bookkeeper" | "internal_operator";
        } | null;
      };
      if (!sessionResponse.ok) throw new Error(sessionPayload.error || "Your organisation could not be loaded.");
      setIsInternalOperator(sessionPayload.internalOperator === true);
      const queryLogsViewer = sessionPayload.queryLogsViewer === true;
      setCanViewQueryLogs(queryLogsViewer);
      if (!queryLogsViewer) {
        setActiveItem((current) => current === "Logs" ? "Chat" : current);
      }
      const nextDeletionReceipt = sessionPayload.deletionReceipt === null
        || sessionPayload.deletionReceipt === undefined
        ? null
        : parseTenantDeletionReceipt(sessionPayload.deletionReceipt);
      if (sessionPayload.deletionReceipt && !nextDeletionReceipt) {
        throw new Error("Your deletion receipt returned invalid state.");
      }
      setTenantDeletionReceipt(nextDeletionReceipt);
      if (sessionPayload.context?.tenant_name && sessionPayload.context.role) {
        setAccountOrganisation({ name: sessionPayload.context.tenant_name, role: sessionPayload.context.role });
      }

      if (nextDeletionReceipt && !sessionPayload.context) {
        setActiveItem("Deletion");
        setAccountOrganisation({ name: "Deletion receipt", role: null });
        setConnectionsData(emptyConnectionsWorkspace);
        setConnectionsStatus({ kind: "ready" });
        return;
      }

      if (sessionPayload.needsBootstrap) {
        const fallbackName = sessionPayload.user?.email?.split("@")[0]?.trim()
          ? `${sessionPayload.user.email.split("@")[0]}'s organisation`
          : "Personal Organisation";
        const bootstrapResponse = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: sessionPayload.user?.suggestedOrganisationName?.trim() || fallbackName,
            timezone: sessionPayload.user?.timezone || "Australia/Melbourne",
          }),
        });
        const bootstrapPayload = await bootstrapResponse.json().catch(() => null) as {
          error?: string;
          context?: {
            tenant_name?: string;
            role?: "owner" | "manager" | "bookkeeper" | "internal_operator";
          };
        } | null;
        if (!bootstrapResponse.ok) throw new Error(bootstrapPayload?.error || "Your organisation could not be created.");
        if (bootstrapPayload?.context?.tenant_name && bootstrapPayload.context.role) {
          setAccountOrganisation({
            name: bootstrapPayload.context.tenant_name,
            role: bootstrapPayload.context.role,
          });
        }
      }

      const response = await fetch("/api/connections", { cache: "no-store" });
      const payload = await response.json() as { workspace?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error || "Connection status could not be loaded.");
      const parsed = parseConnectionsWorkspace(payload.workspace);
      if (!parsed) throw new Error("The connection service returned an invalid response.");
      setConnectionsData(withComingSoonProviders(parsed));
      setConnectionsStatus({ kind: "ready" });
    } catch (error) {
      if (options?.silent) return;
      setConnectionsData(emptyConnectionsWorkspace);
      setConnectionsStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Please try again.",
      });
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => {
      void loadConnections();
    }, 0);
    return () => window.clearTimeout(task);
  }, [loadConnections]);

  const sidebarSyncDomains = useMemo(
    () => collectWorkspaceSyncDomains(connectionsData.providers),
    [connectionsData.providers],
  );
  const sidebarSyncSummary = useMemo(
    () => connectionSyncSummary(sidebarSyncDomains),
    [sidebarSyncDomains],
  );
  const sidebarSyncActive = useMemo(
    () => workspaceSyncIsActive(sidebarSyncDomains) || connectionsData.providers.some((provider) =>
      provider.connections.some((connection) =>
        connectionIngestionIsPending(connection.ingestionState, connection.domains)
      )
    ),
    [connectionsData.providers, sidebarSyncDomains],
  );
  const sidebarSyncFullyComplete = useMemo(() => {
    if (sidebarSyncDomains.length === 0) return false;
    return sidebarSyncDomains.every(
      (domain) =>
        domain.state === "ready_complete"
        && (typeof domain.progress !== "number" || domain.progress >= 100),
    );
  }, [sidebarSyncDomains]);
  const sidebarSyncCommentary = useMemo(
    () => buildSidebarSyncCommentary(sidebarSyncDomains, connectionsData.syncSummary),
    [sidebarSyncDomains, connectionsData.syncSummary],
  );
  const sidebarSyncCommentaryKey = sidebarSyncCommentary.join("\n");
  const [sidebarSyncCommentaryIndex, setSidebarSyncCommentaryIndex] = useState(0);

  useEffect(() => {
    setSidebarSyncCommentaryIndex(0);
  }, [sidebarSyncCommentaryKey]);

  useEffect(() => {
    if (!sidebarSyncActive) return;
    const interval = window.setInterval(() => {
      void loadConnections({ silent: true });
    }, 8_000);
    return () => window.clearInterval(interval);
  }, [sidebarSyncActive, loadConnections]);

  useEffect(() => {
    if (!sidebarSyncActive || sidebarSyncCommentary.length < 2) return;
    const interval = window.setInterval(() => {
      setSidebarSyncCommentaryIndex((current) => (current + 1) % sidebarSyncCommentary.length);
    }, 8_000);
    return () => window.clearInterval(interval);
  }, [sidebarSyncActive, sidebarSyncCommentary]);

  const connectProvider = (providerId: ConnectionProviderId, shopDomain?: string) => {
    if (!isConnectableProviderId(providerId)) return;
    // Shopify hosts its authorize endpoint on the merchant's own shop, so the
    // domain travels with the start request. Every other provider has a
    // central authorize host and sends nothing extra.
    const start = new URL(`/api/oauth/${providerId}/start`, window.location.origin);
    if (providerId === "shopify") {
      const shop = shopDomain?.trim();
      if (!shop) {
        setConnectionsStatus({
          kind: "error",
          message: "Enter your myshopify.com store domain to connect Shopify.",
        });
        return;
      }
      start.searchParams.set("shop", shop);
    }
    window.location.assign(start.toString());
  };

  const selectOAuthAccount = async (oauthSessionId: string, externalAccountId: string) => {
    setConnectionsStatus({ kind: "loading", message: "Finishing the connection." });
    const response = await fetch("/api/oauth/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oauthSessionId, externalAccountId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      setConnectionsStatus({ kind: "error", message: payload?.error || "The account could not be connected." });
      return;
    }
    void loadConnections();
  };

  const disconnectConnection = async (connectionId: string) => {
    setConnectionsStatus({ kind: "loading", message: "Securing the connection and queuing its verified data purge." });
    const response = await fetch("/api/oauth/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      setConnectionsStatus({ kind: "error", message: payload?.error || "The connection could not be disconnected." });
      return;
    }
    void loadConnections();
  };

  const loadConversationSummaries = useCallback(async () => {
    setConversationHistoryStatus({ kind: "loading" });
    try {
      const response = await fetch("/api/conversations?limit=30", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as {
        conversations?: unknown;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(payload?.error || "Conversation history could not be loaded.");
      const parsed = parseConversationSummaries(payload?.conversations);
      if (!parsed) throw new Error("Conversation history returned an invalid response.");
      // Seed seen ids so a history refresh does not replay enter animations.
      for (const conversation of parsed) {
        seenSidebarConversationIdsRef.current.add(conversation.conversationId);
      }
      setConversationSummaries(parsed);
      setConversationHistoryStatus({ kind: "ready" });
      // Backfill missing AI titles for existing threads (cheap nano model).
      const pending = parsed.filter((item) => item.titlePending).slice(0, 8);
      void (async () => {
        for (const item of pending) {
          try {
            const titleResponse = await fetch(
              `/api/conversations/${encodeURIComponent(item.conversationId)}/title`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
              },
            );
            if (!titleResponse.ok) continue;
            const titlePayload = await titleResponse.json().catch(() => null) as {
              title?: unknown;
            } | null;
            if (typeof titlePayload?.title !== "string" || !titlePayload.title.trim()) continue;
            const nextTitle = formatConversationTitle(titlePayload.title);
            setConversationSummaries((current) => current.map((entry) => (
              entry.conversationId === item.conversationId
                ? { ...entry, title: nextTitle, titlePending: false }
                : entry
            )));
          } catch {
            // Best-effort backfill; the next turn can still assign a title.
          }
        }
      })();
    } catch (error) {
      setConversationSummaries([]);
      setConversationHistoryStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Conversation history could not be loaded.",
      });
    }
  }, []);

  useEffect(() => {
    void loadConversationSummaries();
  }, [loadConversationSummaries]);

  useLayoutEffect(() => {
    for (const conversation of conversationSummaries) {
      seenSidebarConversationIdsRef.current.add(conversation.conversationId);
    }
  }, [conversationSummaries]);

  const restoreConversationMessages = useCallback((
    conversationId: string,
    history: Record<string, unknown>,
    fallbackPreferences: AgentRunPreferences,
  ) => {
    const restored: ChatMessage[] = [];
    let messageId = 0;
    let restoredPreferences = fallbackPreferences;
    let restoredRuntime: Exclude<ChatRuntime, "fixture"> = "openai";
    let restoredSpecialistAgentId: SpecialistAgentId = "general";
    if (!Array.isArray(history.turns)) {
      return null;
    }
    for (const rawTurn of history.turns) {
      if (!rawTurn || typeof rawTurn !== "object" || Array.isArray(rawTurn)) continue;
      const turn = rawTurn as Record<string, unknown>;
      if (
        typeof turn.user_message !== "string"
        || typeof turn.turn_id !== "string"
        || !ulidPattern.test(turn.turn_id)
        || !Array.isArray(turn.events)
      ) continue;
      messageId += 1;
      restored.push({ id: messageId, role: "user", text: turn.user_message, suppressEnter: true });
      const events = turn.events
        .map(parseTraceEvent)
        .filter((event): event is TraceEvent => event !== null)
        .sort((left, right) => left.sequence - right.sequence);
      messageId += 1;
      // Server "running" without a live client owner is treated as interrupted.
      // Live background turns keep streaming via the client cache instead.
      const restoredEvents = turn.status === "running"
        ? [...events, buildStoppedTraceEvent(messageId, "This analysis was interrupted.", events.length + 1)]
        : events;
      const turnRuntime = chatRuntimeFromProfile(turn.runtime_profile);
      restoredRuntime = turnRuntime;
      restoredSpecialistAgentId = specialistAgentIdFromProfile(turn.runtime_profile);
      restored.push({
        id: messageId,
        role: "assistant",
        text: "",
        events: restoredEvents,
        isStreaming: false,
        runtime: turnRuntime,
        conversationId,
        turnId: turn.turn_id,
        suppressEnter: true,
      });
      restoredPreferences = normalizeAgentPreferences(turn.runtime_profile);
    }
    if (restored.length === 0) return null;
    return {
      messages: restored,
      preferences: restoredPreferences,
      messageSequence: messageId,
      runtime: restoredRuntime,
      specialistAgentId: restoredSpecialistAgentId,
    };
  }, []);

  const markConversationUnread = useCallback((conversationId: string) => {
    setUnreadConversationIds((current) => {
      if (current.has(conversationId)) return current;
      const next = new Set(current);
      next.add(conversationId);
      return next;
    });
  }, []);

  const clearConversationUnread = useCallback((conversationId: string) => {
    setUnreadConversationIds((current) => {
      if (!current.has(conversationId)) return current;
      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (activeItem === "Chat" && activeConversationId) {
      clearConversationUnread(activeConversationId);
    }
  }, [activeItem, activeConversationId, clearConversationUnread]);

  useLayoutEffect(() => {
    if (!conversationSkelResetting) return;
    // Force a reflow so dropping is-resetting re-enables transitions for the next reveal.
    void conversationSkelHostRef.current?.offsetHeight;
    setConversationSkelResetting(false);
  }, [conversationSkelResetting]);

  useEffect(() => {
    if (conversationSkelPhase !== "revealing") return;
    const revealFrame = window.requestAnimationFrame(() => {
      setConversationSkelRevealed(true);
    });
    return () => {
      window.cancelAnimationFrame(revealFrame);
    };
  }, [conversationSkelPhase]);

  const applyCachedConversation = useCallback((
    conversationId: string,
    cached: {
      messages: ChatMessage[];
      preferences: AgentRunPreferences;
      messageSequence: number;
      runtime: Exclude<ChatRuntime, "fixture">;
      specialistAgentId: SpecialistAgentId;
    },
  ) => {
    const live = liveTurnsRef.current.has(conversationId);
    chatPinAnimationsRef.current.forEach((animation) => animation.stop());
    chatPinAnimationsRef.current = [];
    shouldAnimatePinRef.current = false;
    composerOriginTopRef.current = null;
    lastPinnedUserMessageIdRef.current = null;
    chatMessageSequenceRef.current = cached.messageSequence;
    setChatClarification(null);
    setClarifyDraft("");
    setEditingMessageId(null);
    setEditDraft("");
    setActiveConversationId(conversationId);
    activeConversationIdRef.current = conversationId;
    viewingKeyRef.current = conversationId;
    clearConversationUnread(conversationId);
    setAgentPreferences(cached.preferences);
    setActiveChatRuntime(cached.runtime);
    activeChatRuntimeRef.current = cached.runtime;
    setSpecialistAgentId(cached.specialistAgentId);
    specialistAgentIdRef.current = cached.specialistAgentId;
    const baseMessages = (live ? cached.messages : finalizeStreamingMessages(cached.messages)).map((message) => ({
      ...message,
      suppressEnter: true,
      trailVisible: true,
      isStreaming: live ? Boolean(message.isStreaming) : false,
    }));
    conversationCacheRef.current.set(conversationId, {
      messages: baseMessages,
      preferences: cached.preferences,
      messageSequence: cached.messageSequence,
      runtime: cached.runtime,
      specialistAgentId: cached.specialistAgentId,
    });
    setChatMessages(baseMessages);
    setIsChatResponding(live);
    setComposerExpanded(true);
    setActiveItem("Chat");
    const fromLoading = openingConversationIdRef.current !== null
      || conversationSkelPhaseRef.current === "loading";
    setOpeningConversationId(null);
    if (fromLoading) {
      setConversationSkelPhase("revealing");
      setConversationSkelRevealed(false);
    } else {
      setConversationSkelPhase("idle");
      setConversationSkelRevealed(false);
      setConversationSkelResetting(false);
    }
    setConversationHistoryStatus({ kind: "ready" });
    if (!live) {
      // Drop orphaned sidebar spinners for turns we are not actively owning.
      setComputingConversationIds((current) => {
        if (!current.has(conversationId)) return current;
        const next = new Set(current);
        next.delete(conversationId);
        computingTokensRef.current.delete(conversationId);
        return next;
      });
      setConversationSummaries((current) => current.map((item) => (
        item.conversationId === conversationId && item.lastTurnStatus === "running"
          ? { ...item, lastTurnStatus: "cancelled" }
          : item
      )));
    }
  }, [clearConversationUnread]);

  const prefetchConversation = useCallback(async (conversationId: string) => {
    if (conversationCacheRef.current.has(conversationId)) return;
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = await response.json().catch(() => null) as { history?: unknown } | null;
      if (!payload?.history || typeof payload.history !== "object" || Array.isArray(payload.history)) return;
      const history = payload.history as Record<string, unknown>;
      if (history.conversation_id !== conversationId) return;
      const restored = restoreConversationMessages(conversationId, history, DEFAULT_AGENT_PREFERENCES);
      if (!restored) return;
      if (!conversationCacheRef.current.has(conversationId)) {
        conversationCacheRef.current.set(conversationId, restored);
      }
    } catch {
      // Prefetch failures are ignored; click will retry.
    }
  }, [restoreConversationMessages]);

  const snapshotViewedConversation = () => {
    const messages = chatMessages;
    if (messages.length === 0) return;
    const key = activeConversationId ?? viewingKeyRef.current;
    if (!key) return;
    conversationCacheRef.current.set(key, {
      messages,
      preferences: agentPreferencesRef.current,
      messageSequence: chatMessageSequenceRef.current,
      runtime: activeChatRuntimeRef.current,
      specialistAgentId: specialistAgentIdRef.current,
    });
  };

  const hydrateSwarmConversation = useCallback((conversationId: string) => {
    void fetch(`/api/swarm?conversationId=${encodeURIComponent(conversationId)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (!payload || typeof payload !== "object") return;
        const run = (payload as {
          run?: {
            runId: string;
            parentConversationId: string;
            parentTurnId: string;
            question: string;
            status: string;
            plan?: { periodLabel?: string };
            synthesis?: {
              answer?: string;
              answerState?: string;
              followUps?: string[];
            } | null;
            agents?: readonly {
              agentKey: string;
              title: string;
              tagline: string;
              role: string;
              status: string;
              headline: string | null;
              answerState: string | null;
              conversationId: string | null;
              turnId: string | null;
              failureNote: string | null;
            }[];
          };
        }).run;
        if (!run || run.parentConversationId !== conversationId || !run.agents) return;
        const agents = swarmAgentsFromPersisted(run.agents);
        hydrateSwarmFromRun({
          runId: run.runId,
          parentConversationId: run.parentConversationId,
          parentTurnId: run.parentTurnId,
          question: run.question,
          periodLabel: run.plan?.periodLabel ?? "As asked",
          agents,
          answer: run.synthesis?.answer ?? null,
          answerState: run.synthesis?.answerState ?? null,
          followUps: run.synthesis?.followUps,
        });
        if (run.status === "running" || run.status === "synthesising" || run.synthesis) {
          setSwarmPanelOpen(true);
          setTakeawaysOpen(false);
          setReasoningPanelOpen(false);
        }
        const settled = run.agents.every((agent) => (
          agent.status === "completed" || agent.status === "failed" || agent.status === "stopped"
        ));
        if (!settled || run.synthesis || run.status === "stopped" || run.status === "abandoned") {
          return;
        }
        void fetch("/api/swarm/synthesis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: run.runId }),
        }).then((response) => (response.ok ? response.json() : null)).then((result: unknown) => {
          const synthesis = result && typeof result === "object"
            ? (result as {
              synthesis?: { answer?: string; answerState?: string; followUps?: string[] };
            }).synthesis
            : null;
          if (!synthesis?.answer) return;
          hydrateSwarmFromRun({
            runId: run.runId,
            parentConversationId: run.parentConversationId,
            parentTurnId: run.parentTurnId,
            question: run.question,
            periodLabel: run.plan?.periodLabel ?? "As asked",
            agents,
            answer: synthesis.answer,
            answerState: synthesis.answerState ?? null,
            followUps: synthesis.followUps,
          });
        }).catch(() => undefined);
      })
      .catch(() => undefined);
  }, []);

  const openSavedConversation = async (conversationId: string) => {
    if (conversationId === activeConversationId && activeItem === "Chat" && !openingConversationId) {
      return;
    }

    // Keep background work running; only snapshot the view we are leaving.
    snapshotViewedConversation();

    const requestId = openConversationRequestIdRef.current + 1;
    openConversationRequestIdRef.current = requestId;
    openConversationAbortRef.current?.abort();
    const controller = new AbortController();
    openConversationAbortRef.current = controller;

    setChatClarification(null);
    setClarifyDraft("");
    setActiveItem("Chat");
    setActiveConversationId(conversationId);
    activeConversationIdRef.current = conversationId;
    viewingKeyRef.current = conversationId;
    const summarySpecialist = conversationSummaries.find((item) => item.conversationId === conversationId)?.specialistAgentId;
    if (summarySpecialist) {
      setSpecialistAgentId(summarySpecialist);
      specialistAgentIdRef.current = summarySpecialist;
    }
    void loadConversationSummaries();
    setComposerExpanded(true);
    shouldAnimatePinRef.current = false;
    composerOriginTopRef.current = null;
    lastPinnedUserMessageIdRef.current = null;

    const cached = conversationCacheRef.current.get(conversationId);
    if (cached) {
      applyCachedConversation(conversationId, cached);
    } else {
      if (conversationSkelPhaseRef.current === "revealing") {
        setConversationSkelResetting(true);
        setConversationSkelRevealed(false);
      }
      setChatMessages([]);
      setIsChatResponding(liveTurnsRef.current.has(conversationId));
      setOpeningConversationId(conversationId);
      setConversationSkelPhase("loading");
      setConversationSkelRevealed(false);
    }

    // A live background turn already owns the freshest transcript.
    if (liveTurnsRef.current.has(conversationId)) {
      if (swarmRunSnapshot().parentConversationId === conversationId) {
        setSwarmPanelOpen(true);
        setTakeawaysOpen(false);
        setReasoningPanelOpen(false);
      } else {
        hydrateSwarmConversation(conversationId);
      }
      return;
    }

    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        history?: unknown;
        error?: string;
      } | null;
      if (requestId !== openConversationRequestIdRef.current) return;
      if (!response.ok) throw new Error(payload?.error || "The conversation could not be opened.");
      if (!payload?.history || typeof payload.history !== "object" || Array.isArray(payload.history)) {
        throw new Error("The conversation returned an invalid response.");
      }
      const history = payload.history as Record<string, unknown>;
      if (history.conversation_id !== conversationId || !Array.isArray(history.turns)) {
        throw new Error("The conversation returned invalid state.");
      }

      const restored = restoreConversationMessages(conversationId, history, agentPreferences);
      if (!restored) throw new Error("This conversation does not contain any persisted turns yet.");
      if (requestId !== openConversationRequestIdRef.current) return;
      if (liveTurnsRef.current.has(conversationId)) return;

      const local = conversationCacheRef.current.get(conversationId);
      const localUserCount = local?.messages.filter((message) => message.role === "user").length ?? 0;
      const serverUserCount = restored.messages.filter((message) => message.role === "user").length;
      // Keep local follow-ups that are ahead of the persisted server history.
      if (local && localUserCount > serverUserCount) {
        applyCachedConversation(conversationId, local);
        hydrateSwarmConversation(conversationId);
        return;
      }

      conversationCacheRef.current.set(conversationId, restored);
      applyCachedConversation(conversationId, restored);
      hydrateSwarmConversation(conversationId);
    } catch (error) {
      if (controller.signal.aborted || requestId !== openConversationRequestIdRef.current) return;
      setOpeningConversationId(null);
      setConversationSkelPhase("idle");
      setConversationSkelRevealed(false);
      setConversationSkelResetting(false);
      setChatMessages([]);
      setConversationHistoryStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "The conversation could not be opened.",
      });
    } finally {
      if (openConversationAbortRef.current === controller) {
        openConversationAbortRef.current = null;
      }
    }
  };

  useEffect(() => () => {
    for (const turn of liveTurnsRef.current.values()) {
      turn.controller.abort();
    }
    liveTurnsRef.current.clear();
    openConversationAbortRef.current?.abort();
    chatPinAnimationsRef.current.forEach((animation) => animation.stop());
    if (chatPinTimerRef.current !== undefined) window.clearTimeout(chatPinTimerRef.current);
    if (composerExpandTimerRef.current !== undefined) window.clearTimeout(composerExpandTimerRef.current);
  }, []);

  // Wheel over the top bar / composer (and other non-scroller chrome) should still
  // drive the messages scroller so the chat page feels like one scroll surface.
  useEffect(() => {
    if (activeItem !== "Chat") return;
    const workspace = chatWorkspaceRef.current;
    if (!workspace) return;

    const findScrollableAncestor = (
      start: EventTarget | null,
      boundary: HTMLElement,
    ): HTMLElement | null => {
      let el = start instanceof Element ? start : null;
      while (el && el !== boundary) {
        if (el instanceof HTMLElement) {
          const overflowY = getComputedStyle(el).overflowY;
          if (
            (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
            el.scrollHeight > el.clientHeight + 1
          ) {
            return el;
          }
        }
        el = el.parentElement;
      }
      return null;
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.defaultPrevented) return;
      const scroller = chatMessagesRef.current;
      if (!scroller) return;

      const nested = findScrollableAncestor(event.target, workspace);
      if (nested) {
        if (nested === scroller) return;
        const atTop = nested.scrollTop <= 0;
        const atBottom = nested.scrollTop + nested.clientHeight >= nested.scrollHeight - 1;
        if ((event.deltaY < 0 && !atTop) || (event.deltaY > 0 && !atBottom)) {
          return;
        }
      }

      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      if (maxScroll <= 0) return;
      const next = Math.min(maxScroll, Math.max(0, scroller.scrollTop + event.deltaY));
      if (next === scroller.scrollTop) return;
      scroller.scrollTop = next;
      event.preventDefault();
    };

    workspace.addEventListener("wheel", onWheel, { passive: false });
    return () => workspace.removeEventListener("wheel", onWheel);
  }, [activeItem, chatMessages.length, conversationSkelActive]);

  useLayoutEffect(() => {
    const container = chatMessagesRef.current;
    const spacer = chatSpacerRef.current;
    if (!container || !spacer || chatMessages.length === 0) {
      if (spacer) spacer.style.minHeight = "0px";
      lastPinnedUserMessageIdRef.current = null;
      composerOriginTopRef.current = null;
      return;
    }

    // Must match .chatMessages padding-top. A smaller value made the first-flight
    // pin land above the in-flow rest position, so the bubble dropped a few px
    // when flying styles cleared.
    const topGap = Number.parseFloat(getComputedStyle(container).paddingTop) || 12;
    const gap = 10;

    const clearPinAnimations = () => {
      chatPinAnimationsRef.current.forEach((animation) => animation.stop());
      chatPinAnimationsRef.current = [];
      if (chatPinTimerRef.current !== undefined) {
        window.clearTimeout(chatPinTimerRef.current);
        chatPinTimerRef.current = undefined;
      }
    };

    const computeSpacerHeight = (userEl: HTMLElement) => {
      let contentAfter = 0;
      let sibling = userEl.nextElementSibling as HTMLElement | null;
      while (sibling) {
        contentAfter += sibling.offsetHeight + gap;
        sibling = sibling.nextElementSibling as HTMLElement | null;
      }
      const turnEl = userEl.parentElement;
      if (turnEl && turnEl !== container) {
        let nextTurn = turnEl.nextElementSibling as HTMLElement | null;
        while (nextTurn && nextTurn !== spacer) {
          contentAfter += nextTurn.offsetHeight + gap;
          nextTurn = nextTurn.nextElementSibling as HTMLElement | null;
        }
      }
      return Math.max(0, container.clientHeight - userEl.offsetHeight - contentAfter - topGap);
    };

    const resetFlyingStyles = (element: HTMLElement) => {
      element.style.position = "";
      element.style.top = "";
      element.style.left = "";
      element.style.width = "";
      element.style.zIndex = "";
      element.style.transform = "";
      element.style.opacity = "";
      element.style.transition = "";
      element.style.pointerEvents = "";
      element.style.willChange = "";
      element.style.margin = "";
    };

    const updateSpacerOnly = () => {
      const lastUserMessage = [...chatMessages].reverse().find((message) => message.role === "user");
      if (!lastUserMessage) {
        spacer.style.minHeight = "0px";
        return;
      }
      const userEl = container.querySelector<HTMLElement>(`[data-message-id="${lastUserMessage.id}"]`);
      if (!userEl) return;
      if (userEl.style.position === "fixed") return;
      const nextHeight = computeSpacerHeight(userEl);
      const currentHeight = Number.parseFloat(spacer.style.minHeight) || 0;
      if (Math.abs(nextHeight - currentHeight) < 1) return;
      spacer.style.minHeight = `${nextHeight}px`;
    };

    const revealAssistantTrail = (assistantEl: HTMLElement | null) => {
      if (!assistantEl || assistantEl === spacer) return;
      const assistantId = Number(assistantEl.dataset.messageId);
      if (!Number.isFinite(assistantId)) {
        assistantEl.style.opacity = "";
        return;
      }
      const reveal = () => {
        setChatMessages((messages) => messages.map((message) => (
          message.id === assistantId && message.trailVisible === false
            ? { ...message, trailVisible: true }
            : message
        )));
        if (reduceMotion) {
          assistantEl.style.opacity = "";
          return;
        }
        const revealAnimation = animate(0, 1, {
          duration: 0.28,
          ease: [0.22, 1, 0.36, 1],
          onUpdate: (value) => {
            assistantEl.style.opacity = String(value);
          },
          onComplete: () => {
            assistantEl.style.opacity = "";
          },
        });
        chatPinAnimationsRef.current.push(revealAnimation);
      };
      // Keep the trail hidden for this frame, then fade it in after the pin settles.
      assistantEl.style.opacity = "0";
      window.requestAnimationFrame(reveal);
    };

    const pinWithFlip = (userEl: HTMLElement, messageId: number) => {
      const assistantEl = userEl.nextElementSibling as HTMLElement | null;
      if (assistantEl && assistantEl !== spacer) {
        assistantEl.style.opacity = "0";
      }
      const firstRect = userEl.getBoundingClientRect();
      spacer.style.minHeight = `${computeSpacerHeight(userEl)}px`;
      const userTop = userEl.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTop = Math.max(0, userTop - topGap);
      const lastRect = userEl.getBoundingClientRect();
      const dy = firstRect.top - lastRect.top;
      lastPinnedUserMessageIdRef.current = messageId;

      if (reduceMotion || Math.abs(dy) < 1) {
        resetFlyingStyles(userEl);
        revealAssistantTrail(assistantEl);
        return;
      }

      userEl.style.willChange = "transform";
      const flipAnimation = animate(dy, 0, {
        duration: 0.52,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: (value) => {
          userEl.style.transform = `translateY(${value}px)`;
        },
        onComplete: () => {
          resetFlyingStyles(userEl);
          revealAssistantTrail(assistantEl);
        },
      });
      chatPinAnimationsRef.current.push(flipAnimation);
    };

    const pinFirstMessage = (userEl: HTMLElement, messageId: number, originTop: number) => {
      const assistantEl = userEl.nextElementSibling as HTMLElement | null;
      const startRect = userEl.getBoundingClientRect();
      // Capture the in-flow rest top before taking the bubble out of flow. Animating
      // to container.top + a guessed gap left a few px of settle after reset.
      const destinationTop = startRect.top;

      userEl.style.position = "fixed";
      userEl.style.top = `${originTop}px`;
      userEl.style.left = `${startRect.left}px`;
      userEl.style.width = `${startRect.width}px`;
      userEl.style.zIndex = "6";
      userEl.style.margin = "0";
      userEl.style.willChange = "top, opacity";
      userEl.style.pointerEvents = "none";
      userEl.style.opacity = "0";
      userEl.style.transform = "none";

      if (assistantEl && assistantEl !== spacer) {
        assistantEl.style.opacity = "0";
      }

      spacer.style.minHeight = `${computeSpacerHeight(userEl)}px`;
      container.scrollTop = 0;
      lastPinnedUserMessageIdRef.current = messageId;

      const fadeAnimation = animate(0, 1, {
        duration: 0.22,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: (value) => {
          userEl.style.opacity = String(value);
        },
      });
      chatPinAnimationsRef.current.push(fadeAnimation);

      const slideAnimation = animate(originTop, destinationTop, {
        duration: 0.5,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: (value) => {
          userEl.style.top = `${value}px`;
        },
        onComplete: () => {
          resetFlyingStyles(userEl);
          spacer.style.minHeight = `${computeSpacerHeight(userEl)}px`;
          container.scrollTop = 0;
          revealAssistantTrail(assistantEl);
          composerOriginTopRef.current = null;
        },
      });
      chatPinAnimationsRef.current.push(slideAnimation);
    };

    const lastUserMessage = [...chatMessages].reverse().find((message) => message.role === "user");
    if (!lastUserMessage) {
      spacer.style.minHeight = "0px";
      return;
    }

    const userEl = container.querySelector<HTMLElement>(`[data-message-id="${lastUserMessage.id}"]`);
    if (!userEl) return;

    const deferredAssistant = [...chatMessages].reverse().find(
      (message) => message.role === "assistant" && message.trailVisible === false,
    );
    const revealDeferredTrail = () => {
      if (!deferredAssistant) return;
      revealAssistantTrail(
        container.querySelector<HTMLElement>(`[data-message-id="${deferredAssistant.id}"]`),
      );
    };

    const alreadyPinned = lastPinnedUserMessageIdRef.current === lastUserMessage.id;
    if (alreadyPinned) {
      updateSpacerOnly();
      // Only reveal when a trail is still deferred. Restored chats already have
      // visible trails; forcing an opacity fade makes the step bar flash.
      revealDeferredTrail();
    } else {
      clearPinAnimations();
      const originTop = composerOriginTopRef.current;
      const shouldAnimate = shouldAnimatePinRef.current;
      shouldAnimatePinRef.current = false;
      if (shouldAnimate && originTop !== null && !reduceMotion) {
        pinFirstMessage(userEl, lastUserMessage.id, originTop);
      } else if (shouldAnimate && originTop !== null && reduceMotion) {
        spacer.style.minHeight = `${computeSpacerHeight(userEl)}px`;
        container.scrollTop = 0;
        lastPinnedUserMessageIdRef.current = lastUserMessage.id;
        composerOriginTopRef.current = null;
        revealDeferredTrail();
      } else if (shouldAnimate) {
        pinWithFlip(userEl, lastUserMessage.id);
      } else {
        spacer.style.minHeight = `${computeSpacerHeight(userEl)}px`;
        const userTop = userEl.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
        container.scrollTop = Math.max(0, userTop - topGap);
        lastPinnedUserMessageIdRef.current = lastUserMessage.id;
        composerOriginTopRef.current = null;
        // Instant switch: keep trails painted. Do not opacity-flash the step bar.
        revealDeferredTrail();
      }
    }

    let resizeFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        updateSpacerOnly();
      });
    });
    resizeObserver.observe(container);
    Array.from(container.children).forEach((child) => {
      if (child !== spacer) resizeObserver.observe(child);
    });

    return () => {
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
    };
  }, [chatMessages, reduceMotion]);

  useEffect(() => {
    if (!accountOpen) return;

    accountPreviousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : accountTriggerRef.current;
    const popover = accountPopoverRef.current;
    const focusFrame = window.requestAnimationFrame(() => {
      const selectedTheme = popover?.querySelector<HTMLElement>("[aria-pressed=\"true\"]");
      const firstControl = popover?.querySelector<HTMLElement>("button:not(:disabled), [href]");
      (selectedTheme ?? firstControl)?.focus();
    });

    const closeMenuOnOutsidePress = (event: PointerEvent) => {
      if (!accountAreaRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };

    const handleMenuKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setAccountOpen(false);
        return;
      }
      if (event.key !== "Tab" || !popover) return;
      const focusable = [
        ...popover.querySelectorAll<HTMLElement>("button:not(:disabled), [href]"),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("pointerdown", closeMenuOnOutsidePress);
    document.addEventListener("keydown", handleMenuKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeMenuOnOutsidePress);
      document.removeEventListener("keydown", handleMenuKeyDown);
      const previousFocus = accountPreviousFocusRef.current;
      accountPreviousFocusRef.current = null;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [accountOpen]);

  useEffect(() => {
    if (canUseCustomerAgent) return;
    setAgentsOpen(false);
  }, [canUseCustomerAgent]);

  useEffect(() => {
    if (!agentsOpen) return;

    const popover = agentsPopoverRef.current;
    const focusFrame = window.requestAnimationFrame(() => {
      popover?.querySelector<HTMLElement>("[role=\"menuitemradio\"]")?.focus();
    });
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!agentsAreaRef.current?.contains(event.target as Node)) setAgentsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setAgentsOpen(false);
        window.requestAnimationFrame(() => agentsTriggerRef.current?.focus());
        return;
      }
      if (event.key === "Tab") {
        setAgentsOpen(false);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...(popover?.querySelectorAll<HTMLElement>("[role=\"menuitemradio\"]") ?? [])];
      if (items.length === 0) return;
      event.preventDefault();
      const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [agentsOpen]);

  const markConversationComputing = useCallback((conversationId: string) => {
    const token = Symbol(conversationId);
    computingTokensRef.current.set(conversationId, token);
    setComputingConversationIds(new Set(computingTokensRef.current.keys()));
    return token;
  }, []);

  const clearConversationComputing = useCallback((conversationId: string, token: symbol) => {
    if (computingTokensRef.current.get(conversationId) !== token) return;
    computingTokensRef.current.delete(conversationId);
    setComputingConversationIds(new Set(computingTokensRef.current.keys()));
  }, []);

  const sendChatMessage = async (
    suggestedText?: string,
    confirmedOption?: Readonly<{ offeredTurnId: string; optionId: string }>,
    options?: Readonly<{
      conversationId?: string | null;
      priorMessageCount?: number;
      allowWhileResponding?: boolean;
      /** Voice mode pins the governed codex pipeline regardless of the selector. */
      forceRuntime?: "codex";
      /** Voice mode trades analysis depth for latency with a fast profile. */
      preferencesOverride?: AgentRunPreferences;
      /** Voice narration listens to the turn without owning the chat UI. */
      observer?: VoiceTurnObserver;
      swarmKind?: "sales-deep";
    }>,
  ) => {
    const text = (suggestedText ?? chatDraft).trim();
    if (!text) return;
    // Allow a typed / chip follow-up while a turn is still streaming: abort the
    // in-flight turn on this conversation and start the next question. Blocking
    // Enter silently made follow-ups feel broken on long inventory/SQL turns.
    if (
      isChatResponding
      && !options?.allowWhileResponding
      && !(activeConversationId || (options && "conversationId" in options))
    ) {
      return;
    }

    const requestConversationId = options && "conversationId" in options
      ? (options.conversationId ?? undefined)
      : activeConversationId;
    const liveSwarm = swarmRunSnapshot();
    if (
      liveSwarm.active
      && liveSwarm.parentConversationId
      && liveSwarm.parentConversationId === requestConversationId
    ) {
      stopSwarmFleet();
    }
    let turnKey = requestConversationId && ulidPattern.test(requestConversationId)
      ? requestConversationId
      : `draft:${Date.now().toString(36)}`;

    const priorMessages = options?.priorMessageCount !== undefined
      ? chatMessages.slice(0, options.priorMessageCount)
      : chatMessages;
    const existing = liveTurnsRef.current.get(turnKey);
    // Replacement is only for an accepted turn that is still in flight and
    // is being superseded by a newly typed follow-up. A completed assistant
    // turn is conversation history: sending its id here rewinds it instead of
    // appending, which destroys the context referential follow-ups need.
    const replaceTurnId = existing?.turnId;
    const lastConversationRuntime = [...priorMessages]
      .reverse()
      .find((message) => message.runtime && message.runtime !== "fixture")
      ?.runtime as Exclude<ChatRuntime, "fixture"> | undefined;

    // Only replace an in-flight turn on the same conversation; others keep running.
    if (existing && !existing.controller.signal.aborted) {
      existing.controller.abort();
      liveTurnsRef.current.delete(turnKey);
    }

    chatMessageSequenceRef.current += 2;
    const userId = chatMessageSequenceRef.current - 1;
    const assistantId = chatMessageSequenceRef.current;
    const messageSequenceAtStart = chatMessageSequenceRef.current;
    const priorMessageCount = options?.priorMessageCount ?? chatMessages.length;
    const firstFlight = priorMessageCount === 0;
    let trackedConversationId = requestConversationId;
    let computingToken = trackedConversationId
      ? markConversationComputing(trackedConversationId)
      : null;
    const runPreferences = options?.preferencesOverride ?? agentPreferencesRef.current;
    const runSpecialistAgentId = specialistAgentIdRef.current;
    const runRuntime = swarmEnabledRef.current
      ? "codex"
      : options?.forceRuntime
      ? options.forceRuntime
      : activeChatRuntimeRef.current === "codex"
      ? "codex"
      : isAnthropicModel(runPreferences.model)
      ? "v3"
      : activeChatRuntimeRef.current === "xero_mcp"
      ? "xero_mcp"
      : isXaiModel(runPreferences.model)
        ? "v3"
    : (requestConversationId && lastConversationRuntime)
          ? lastConversationRuntime
          : activeChatRuntimeRef.current;
    const runSolPlanner = runRuntime === "codex"
      ? codexSolPlannerEnabledRef.current
      : false;
    const runProMode = runRuntime === "codex"
      ? codexProModeEnabledRef.current
      : false;
    if (firstFlight && chatComposerRef.current) {
      composerOriginTopRef.current = chatComposerRef.current.getBoundingClientRect().top;
    } else {
      composerOriginTopRef.current = null;
    }
    shouldAnimatePinRef.current = firstFlight;
    viewingKeyRef.current = turnKey;

    const initialMessages = (() => {
      const base = priorMessages;
      const finalized = finalizeStreamingMessages(base, "Stopped.");
      return [
        ...finalized,
        { id: userId, role: "user" as const, text, suppressEnter: firstFlight },
        {
          id: assistantId,
          role: "assistant" as const,
          text: "",
          isStreaming: true,
          events: [] as TraceEvent[],
          runtime: runRuntime,
          suppressEnter: firstFlight,
          trailVisible: Boolean(reduceMotion) || !firstFlight,
        },
      ];
    })();

    setChatMessages(initialMessages);
    conversationCacheRef.current.set(turnKey, {
      messages: initialMessages,
      preferences: runPreferences,
      messageSequence: messageSequenceAtStart,
      runtime: runRuntime,
      specialistAgentId: runSpecialistAgentId,
    });
    if (trackedConversationId) {
      const now = new Date().toISOString();
      setConversationSummaries((current) => {
        const existingSummary = current.find((item) => item.conversationId === trackedConversationId);
        if (!existingSummary) return current;
        return [
          {
            ...existingSummary,
            updatedAt: now,
            lastMessage: text,
            lastTurnStatus: "running",
          },
          ...current.filter((item) => item.conversationId !== trackedConversationId),
        ];
      });
    }
    if (firstFlight) {
      if (composerExpandTimerRef.current !== undefined) {
        window.clearTimeout(composerExpandTimerRef.current);
      }
      if (reduceMotion) {
        setComposerExpanded(true);
      } else {
        composerExpandTimerRef.current = window.setTimeout(() => {
          setComposerExpanded(true);
          composerExpandTimerRef.current = undefined;
        }, 300);
      }
    }
    setChatDraft("");
    setChatClarification(null);
    setClarifyDraft("");
    setEditingMessageId(null);
    setEditDraft("");
    setIsChatResponding(true);

    const controller = new AbortController();
    liveTurnsRef.current.set(turnKey, {
      controller,
      assistantId,
      preferences: runPreferences,
      runtime: runRuntime,
      specialistAgentId: runSpecialistAgentId,
    });
    const receivedEvents: TraceEvent[] = [];
    let observerNotified = false;
    let observerFailure: string | null = null;
    const debug = createRawDebugRecorder({
      enabled: rawDebugOnRef.current,
      id: `turn_${assistantId}`,
      prompt: text,
      onUpdate: (record) => setRawDebugTurns((current) => mergeRawDebugTurn(current, record)),
    });

    const isViewingThisTurn = () => viewingKeyRef.current === turnKey
      || (
        Boolean(trackedConversationId)
        && activeConversationIdRef.current === trackedConversationId
      );

    const commitMessages = (next: ChatMessage[]) => {
      const cacheKey = trackedConversationId && ulidPattern.test(trackedConversationId)
        ? trackedConversationId
        : turnKey;
      conversationCacheRef.current.set(cacheKey, {
        messages: next,
        preferences: runPreferences,
        runtime: runRuntime,
        specialistAgentId: runSpecialistAgentId,
        messageSequence: Math.max(
          messageSequenceAtStart,
          conversationCacheRef.current.get(cacheKey)?.messageSequence ?? 0,
        ),
      });
      if (isViewingThisTurn()) {
        setChatMessages(next);
      }
    };

    const updateAssistant = (patch: Partial<ChatMessage>) => {
      if (liveTurnsRef.current.get(turnKey)?.controller !== controller) return;
      const cacheKey = trackedConversationId && ulidPattern.test(trackedConversationId)
        ? trackedConversationId
        : turnKey;
      const apply = (messages: ChatMessage[]) => messages.map((message) => (
        message.id === assistantId ? { ...message, ...patch } : message
      ));
      if (isViewingThisTurn()) {
        setChatMessages((messages) => {
          const next = apply(messages);
          conversationCacheRef.current.set(cacheKey, {
            messages: next,
            preferences: runPreferences,
            messageSequence: chatMessageSequenceRef.current,
            runtime: runRuntime,
            specialistAgentId: runSpecialistAgentId,
          });
          return next;
        });
        return;
      }
      const current = conversationCacheRef.current.get(cacheKey)?.messages;
      if (current) commitMessages(apply(current));
    };

    let swarmFleetStarted = false;
    try {
      if (swarmEnabledRef.current) {
        debug.request("/api/swarm", {
          message: text,
          preferences: runPreferences,
          solPlanner: runSolPlanner,
          proMode: runProMode,
        });
        const response = await fetch("/api/swarm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            preferences: runPreferences,
            solPlanner: runSolPlanner,
            proMode: runProMode,
            ...(requestConversationId ? { conversationId: requestConversationId } : {}),
            ...(requestConversationId && replaceTurnId ? { replaceTurnId } : {}),
            ...(options?.swarmKind ? { kind: options.swarmKind } : {}),
          }),
          signal: controller.signal,
        });
        if (liveTurnsRef.current.get(turnKey)?.controller !== controller) return;
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(describeChatFailure(payload?.error || `HTTP ${response.status}`, {
            runtime: "codex",
            httpStatus: response.status,
            phase: "start",
          }));
        }
        const responseConversationId = response.headers.get("X-Albert-Conversation-Id");
        const responseTurnId = response.headers.get("X-Albert-Turn-Id");
        const payload = await response.json() as {
          run?: { runId?: string; plan?: { periodLabel?: string } };
          agents?: readonly {
            key: string;
            title: string;
            tagline: string;
            role: string;
            prompt: string;
          }[];
          preferences?: {
            model: string;
            reasoningEffort: string;
            fastMode: boolean;
            solPlanner: boolean;
            proMode: boolean;
          };
          concurrency?: number;
        };
        if (
          !responseConversationId || !ulidPattern.test(responseConversationId)
          || !responseTurnId || !ulidPattern.test(responseTurnId)
          || !payload.run?.runId
          || !payload.agents
        ) {
          throw new Error("The swarm did not return its conversation or agents.");
        }
        if (trackedConversationId && computingToken && trackedConversationId !== responseConversationId) {
          clearConversationComputing(trackedConversationId, computingToken);
        }
        const previousKey = turnKey;
        trackedConversationId = responseConversationId;
        turnKey = responseConversationId;
        computingToken = markConversationComputing(responseConversationId);
        const live = liveTurnsRef.current.get(previousKey);
        if (live) {
          liveTurnsRef.current.delete(previousKey);
          liveTurnsRef.current.set(turnKey, { ...live, turnId: responseTurnId });
        }
        const draftCache = conversationCacheRef.current.get(previousKey);
        if (draftCache) {
          conversationCacheRef.current.delete(previousKey);
          conversationCacheRef.current.set(turnKey, draftCache);
        }
        if (viewingKeyRef.current === previousKey) viewingKeyRef.current = turnKey;
        if (
          !activeConversationIdRef.current
          || activeConversationIdRef.current === requestConversationId
          || viewingKeyRef.current === turnKey
        ) {
          setActiveConversationId(responseConversationId);
          activeConversationIdRef.current = responseConversationId;
        }
        setActiveChatRuntime("codex");
        activeChatRuntimeRef.current = "codex";
        const now = new Date().toISOString();
        setConversationSummaries((current) => {
          const existingSummary = current.find((item) => item.conversationId === responseConversationId);
          return [{
            conversationId: responseConversationId,
            title: existingSummary?.title || formatConversationTitle(text),
            titlePending: existingSummary?.titlePending ?? true,
            status: existingSummary?.status || "active",
            updatedAt: now,
            lastMessage: text,
            lastTurnStatus: "running",
            runtime: "codex",
            specialistAgentId: runSpecialistAgentId,
          }, ...current.filter((item) => item.conversationId !== responseConversationId)];
        });
        updateAssistant({
          runtime: "codex",
          conversationId: responseConversationId,
          turnId: responseTurnId,
        });
        startSwarmFleet({
          runId: payload.run.runId,
          parentConversationId: responseConversationId,
          parentTurnId: responseTurnId,
          question: text,
          periodLabel: payload.run.plan?.periodLabel ?? "As asked",
          agents: payload.agents,
          preferences: payload.preferences ?? {
            model: runPreferences.model,
            reasoningEffort: runPreferences.reasoningEffort,
            fastMode: runPreferences.fastMode,
            solPlanner: runSolPlanner,
            proMode: runProMode,
          },
          concurrency: payload.concurrency ?? 3,
        });
        swarmFleetStarted = true;
        setSwarmPanelOpen(true);
        setTakeawaysOpen(false);
        setReasoningPanelOpen(false);
        return;
      }
      const requestBody = {
        message: text,
        ...(runRuntime === "openai" || runRuntime === "v3" || runRuntime === "codex" || runRuntime === "xero_mcp" ? { preferences: runPreferences } : {}),
        ...(runRuntime === "codex" ? { solPlanner: runSolPlanner } : {}),
        ...(runRuntime === "codex" ? { proMode: runProMode } : {}),
        ...(requestConversationId ? { conversationId: requestConversationId } : {}),
        ...(requestConversationId && replaceTurnId ? { replaceTurnId } : {}),
        ...(runRuntime === "v3" ? { specialistAgentId: runSpecialistAgentId } : {}),
        confirmedOption,
      };
      const endpoint = runRuntime === "codex"
        ? "/api/codex-conversation"
        : runRuntime === "anthropic"
        ? "/api/anthropic-conversation"
        : runRuntime === "cubecore"
          ? "/api/cube-conversation"
          : runRuntime === "xero_mcp"
            ? "/api/xero-mcp-conversation"
            : runRuntime === "v3"
              ? "/api/v3-conversation"
              : "/api/conversation";
      debug.request(endpoint, requestBody);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (liveTurnsRef.current.get(turnKey)?.controller !== controller) return;

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        debug.response(response, { runtime: "n/a", conversationId: null, turnId: null });
        debug.note("Request rejected before streaming", payload);
        throw new Error(describeChatFailure(payload?.error || `HTTP ${response.status}`, {
          runtime: runRuntime,
          httpStatus: response.status,
          phase: "start",
        }));
      }

      const runtimeHeader = response.headers.get("X-Albert-Runtime");
      const runtime: ChatRuntime = runtimeHeader === "fixture"
        ? "fixture"
        : runtimeHeader === "codex"
          ? "codex"
        : runtimeHeader === "anthropic"
          ? "anthropic"
          : runtimeHeader === "cubecore"
            ? "cubecore"
            : runtimeHeader === "xero_mcp"
              ? "xero_mcp"
              : runtimeHeader === "v3"
                ? "v3"
                : "openai";
      const responseConversationId = response.headers.get("X-Albert-Conversation-Id");
      const responseTurnId = response.headers.get("X-Albert-Turn-Id");
      const responseSpecialistAgentId = parseSpecialistAgentId(
        response.headers.get("X-Albert-Specialist-Agent"),
      );
      debug.response(response, {
        runtime,
        conversationId: responseConversationId,
        turnId: responseTurnId,
      });
      if (runtime !== "fixture" && runtime !== runRuntime) {
        await response.body?.cancel("runtime_lock_mismatch");
        throw new Error("The conversation runtime did not match the selected method.");
      }
      if (runtime === "codex" && response.headers.get("X-Albert-Model") !== runPreferences.model) {
        await response.body?.cancel("codex_model_mismatch");
        throw new Error("The Codex conversation did not use the selected model.");
      }
      if (runtime === "v3" && responseSpecialistAgentId !== runSpecialistAgentId) {
        await response.body?.cancel("specialist_agent_lock_mismatch");
        throw new Error("The conversation specialist did not match the selected agent.");
      }
      if (runtime !== "fixture" && (
        !responseConversationId || !ulidPattern.test(responseConversationId)
        || !responseTurnId || !ulidPattern.test(responseTurnId)
      )) {
        await response.body?.cancel("missing_immutable_turn_identifiers");
        throw new Error("The governed stream did not include its immutable turn identifiers.");
      }
      if (responseConversationId && ulidPattern.test(responseConversationId)) {
        if (trackedConversationId && computingToken && trackedConversationId !== responseConversationId) {
          clearConversationComputing(trackedConversationId, computingToken);
        }
        const previousKey = turnKey;
        trackedConversationId = responseConversationId;
        turnKey = responseConversationId;
        computingToken = markConversationComputing(responseConversationId);
        const live = liveTurnsRef.current.get(previousKey);
        if (live) {
          liveTurnsRef.current.delete(previousKey);
          liveTurnsRef.current.set(turnKey, {
            ...live,
            ...(responseTurnId && ulidPattern.test(responseTurnId) ? { turnId: responseTurnId } : {}),
          });
        }
        const draftCache = conversationCacheRef.current.get(previousKey);
        if (draftCache) {
          conversationCacheRef.current.delete(previousKey);
          conversationCacheRef.current.set(turnKey, draftCache);
        }
        if (viewingKeyRef.current === previousKey) {
          viewingKeyRef.current = turnKey;
        }
        // Don't yank the user back if they already opened another chat.
        if (
          !activeConversationIdRef.current
          || activeConversationIdRef.current === requestConversationId
          || viewingKeyRef.current === turnKey
        ) {
          setActiveConversationId(responseConversationId);
          activeConversationIdRef.current = responseConversationId;
        }
        const now = new Date().toISOString();
        setConversationSummaries((current) => {
          const existingSummary = current.find((item) => item.conversationId === responseConversationId);
          const nextItem: ConversationSummary = {
            conversationId: responseConversationId,
            title: existingSummary?.title || formatConversationTitle(text),
            titlePending: existingSummary?.titlePending ?? true,
            status: existingSummary?.status || "active",
            updatedAt: now,
            lastMessage: text,
            lastTurnStatus: "running",
            runtime: runRuntime,
            specialistAgentId: runSpecialistAgentId,
          };
          return [nextItem, ...current.filter((item) => item.conversationId !== responseConversationId)];
        });
      }
      updateAssistant({
        runtime,
        ...(responseConversationId && responseTurnId ? {
          conversationId: responseConversationId,
          turnId: responseTurnId,
        } : {}),
      });
      if (responseTurnId && ulidPattern.test(responseTurnId)) {
        const live = liveTurnsRef.current.get(turnKey);
        if (live) liveTurnsRef.current.set(turnKey, { ...live, turnId: responseTurnId });
      }
      if (runtime !== "fixture" && isViewingThisTurn()) {
        setActiveChatRuntime(runtime);
        activeChatRuntimeRef.current = runtime;
      }

      if (!response.body) {
        throw new Error(describeChatFailure(new Error("The conversation stream was unavailable."), {
          runtime,
          phase: "stream",
        }));
      }
      const reader = response.body.getReader();
      const cancelReader = () => {
        void reader.cancel("client_stop").catch(() => undefined);
      };
      if (controller.signal.aborted) {
        cancelReader();
      } else {
        controller.signal.addEventListener("abort", cancelReader, { once: true });
      }
      const decoder = new TextDecoder();
      let buffer = "";

      const acceptBlock = (block: string) => {
        if (liveTurnsRef.current.get(turnKey)?.controller !== controller) return;
        debug.frame(block);
        const lines = block.split("\n");
        const eventName = lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim() || "message";
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) {
          debug.dropped("no data lines", block);
          return;
        }

        if (eventName === "conversation_title") {
          try {
            const payload = JSON.parse(data) as {
              conversationId?: unknown;
              title?: unknown;
            };
            if (
              typeof payload.conversationId === "string"
              && ulidPattern.test(payload.conversationId)
              && typeof payload.title === "string"
              && payload.title.trim()
            ) {
              const nextTitle = formatConversationTitle(payload.title);
              setConversationSummaries((current) => current.map((item) => (
                item.conversationId === payload.conversationId
                  ? { ...item, title: nextTitle, titlePending: false }
                  : item
              )));
            }
          } catch {
            debug.dropped("rejected conversation title payload", data);
          }
          return;
        }

        const event = parseTraceEvent(JSON.parse(data));
        if (!event) {
          debug.dropped("rejected by client trace schema", data);
          return;
        }
        if (receivedEvents.some((item) => item.id === event.id)) {
          debug.dropped(`duplicate event id ${event.id}`, data);
          return;
        }
        debug.event(event);
        receivedEvents.push(event);
        receivedEvents.sort((first, second) => first.sequence - second.sequence);
        updateAssistant({ events: [...receivedEvents] });
        options?.observer?.onEvent(event);
      };

      while (true) {
        if (controller.signal.aborted || liveTurnsRef.current.get(turnKey)?.controller !== controller) {
          cancelReader();
          break;
        }
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          acceptBlock(block);
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
      if (controller.signal.aborted) {
        debug.finish("stopped");
        const stoppedEvent = buildStoppedTraceEvent(
          assistantId,
          "Stopped.",
          receivedEvents.length + 1,
        );
        const cacheKey = trackedConversationId && ulidPattern.test(trackedConversationId)
          ? trackedConversationId
          : turnKey;
        const current = conversationCacheRef.current.get(cacheKey)?.messages ?? initialMessages;
        commitMessages(current.map((message) => (
          message.id === assistantId
            ? {
              ...message,
              isStreaming: false,
              events: receivedEvents.length > 0 ? [...receivedEvents, stoppedEvent] : [stoppedEvent],
            }
            : message
        )));
        return;
      }
      if (liveTurnsRef.current.get(turnKey)?.controller !== controller) return;
      if (buffer.trim()) acceptBlock(buffer);
      if (receivedEvents.length === 0) {
        throw new Error(describeChatFailure(new Error("empty analysis trace"), {
          runtime,
          phase: "empty_trace",
        }));
      }
      debug.finish("complete");

      const cacheKey = trackedConversationId && ulidPattern.test(trackedConversationId)
        ? trackedConversationId
        : turnKey;
      const current = conversationCacheRef.current.get(cacheKey)?.messages ?? initialMessages;
      commitMessages(current.map((message) => (
        message.id === assistantId
          ? { ...message, isStreaming: false, events: [...receivedEvents] }
          : message
      )));
      void loadConversationSummaries();
    } catch (error) {
      debug.failed(error);
      debug.finish(controller.signal.aborted ? "stopped" : "error");
      if (liveTurnsRef.current.get(turnKey)?.controller !== controller && !controller.signal.aborted) {
        return;
      }
      const cacheKey = trackedConversationId && ulidPattern.test(trackedConversationId)
        ? trackedConversationId
        : turnKey;
      const current = conversationCacheRef.current.get(cacheKey)?.messages ?? initialMessages;
      if (controller.signal.aborted) {
        const stoppedEvent = buildStoppedTraceEvent(
          assistantId,
          "Stopped.",
          receivedEvents.length + 1,
        );
        commitMessages(current.map((message) => (
          message.id === assistantId
            ? {
              ...message,
              isStreaming: false,
              events: receivedEvents.length > 0 ? [...receivedEvents, stoppedEvent] : [stoppedEvent],
            }
            : message
        )));
        return;
      }
      const message = describeChatFailure(error, { runtime: runRuntime, phase: "start" });
      observerFailure = message;
      const errorEvent: TraceEvent = {
        id: `trace_error_${assistantId}`,
        sequence: receivedEvents.length + 1,
        type: "error",
        status: "error",
        occurredAt: new Date().toISOString(),
        message,
        recoverable: true,
      };
      commitMessages(current.map((entry) => (
        entry.id === assistantId
          ? { ...entry, isStreaming: false, events: [...receivedEvents, errorEvent] }
          : entry
      )));
    } finally {
      if (swarmFleetStarted) {
        return;
      }
      if (options?.observer && !observerNotified) {
        observerNotified = true;
        const answer = [...receivedEvents]
          .reverse()
          .find((event): event is TraceAnswerEvent => event.type === "answer");
        const clarification = [...receivedEvents]
          .reverse()
          .find((event): event is TraceClarificationEvent => event.type === "clarification");
        options.observer.onDone(
          controller.signal.aborted
            ? { stopped: true }
            : clarification && (!answer || answer.state === "Clarification")
              ? { clarification }
              : answer
                ? { answer }
                : { error: observerFailure ?? "The analysis ended without an answer." },
        );
      }
      if (
        trackedConversationId
        && computingToken
        && !(controller.signal.aborted && runRuntime === "codex")
      ) {
        clearConversationComputing(trackedConversationId, computingToken);
      }
      if (liveTurnsRef.current.get(turnKey)?.controller === controller) {
        liveTurnsRef.current.delete(turnKey);
      }
      if (isViewingThisTurn()) {
        setIsChatResponding(false);
      }
      if (trackedConversationId) {
        const completedAway = !controller.signal.aborted
          && (
            activeConversationIdRef.current !== trackedConversationId
            || activeItemRef.current !== "Chat"
          );
        if (completedAway) {
          markConversationUnread(trackedConversationId);
        } else {
          clearConversationUnread(trackedConversationId);
        }
        setConversationSummaries((current) => current.map((item) => (
          item.conversationId === trackedConversationId
            ? {
              ...item,
              lastTurnStatus: controller.signal.aborted
                ? (runRuntime === "codex" ? "running" : "cancelled")
                : "completed",
            }
            : item
        )));
      }
    }
  };

  useEffect(() => {
    const snap = swarmSnapshot;
    if (!snap.parentConversationId || !snap.runId) return;
    const cacheKey = snap.parentConversationId;
    const cache = conversationCacheRef.current.get(cacheKey);
    const live = liveTurnsRef.current.get(cacheKey);
    if (!cache && !live) return;

    const planEvent: TraceEvent = {
      id: `swarm_plan_${snap.runId}`,
      sequence: 2,
      type: "plan",
      occurredAt: new Date().toISOString(),
      steps: swarmPlanSteps({
        agents: snap.agents.map((agent) => ({
          key: agent.key,
          title: agent.title,
          status: agent.phase,
        })),
        synthesising: snap.synthesising,
        synthesised: Boolean(snap.answer),
      }),
    };
    const ackEvent: TraceEvent = {
      id: `swarm_ack_${snap.runId}`,
      sequence: 1,
      type: "narrative",
      purpose: "acknowledgement",
      occurredAt: new Date().toISOString(),
      text: snap.periodLabel && snap.periodLabel !== "As asked"
        ? `I'll split this across ${snap.agents.length} specialists for ${snap.periodLabel}.`
        : `I'll split this across ${snap.agents.length} specialists, then combine what they find.`,
    };
    const events: TraceEvent[] = [ackEvent, planEvent];
    if (snap.answer) {
      const answerState: AnswerState = (
        snap.answerState === "Verified"
        || snap.answerState === "Derived"
        || snap.answerState === "Qualified"
        || snap.answerState === "Exploratory"
        || snap.answerState === "Clarification"
        || snap.answerState === "No data"
        || snap.answerState === "Unavailable"
      ) ? snap.answerState : "Derived";
      events.push({
        id: `swarm_answer_${snap.runId}`,
        sequence: 3,
        type: "answer",
        status: answerState === "Unavailable" ? "warning" : "complete",
        occurredAt: new Date().toISOString(),
        state: answerState,
        text: snap.answer,
        provenance: swarmEmptyProvenance("Australia/Melbourne"),
        followUps: [...snap.followUps],
        presentedResultIds: [],
        claims: [],
      });
    } else if (snap.error) {
      events.push({
        id: `swarm_error_${snap.runId}`,
        sequence: 3,
        type: "error",
        status: "error",
        occurredAt: new Date().toISOString(),
        message: snap.error,
        recoverable: true,
      });
    }

    const patch = (messages: ChatMessage[]): ChatMessage[] => messages.map((message) => {
      if (message.role !== "assistant") return message;
      if (snap.parentTurnId && message.turnId && message.turnId !== snap.parentTurnId) return message;
      if (!snap.parentTurnId && !message.isStreaming && !message.turnId) return message;
      return {
        ...message,
        isStreaming: !snap.answer && !snap.error && snap.active,
        conversationId: snap.parentConversationId ?? message.conversationId,
        turnId: snap.parentTurnId ?? message.turnId,
        runtime: "codex",
        events,
      };
    });

    if (cache) {
      const next = { ...cache, messages: patch(cache.messages) };
      conversationCacheRef.current.set(cacheKey, next);
      if (
        activeConversationIdRef.current === cacheKey
        || viewingKeyRef.current === cacheKey
      ) {
        setChatMessages(next.messages);
      }
    } else if (
      activeConversationIdRef.current === cacheKey
      || viewingKeyRef.current === cacheKey
    ) {
      setChatMessages((current) => patch(current));
    }

    if (!snap.answer && !snap.error) return;
    if (live && liveTurnsRef.current.get(cacheKey) === live) {
      liveTurnsRef.current.delete(cacheKey);
    }
    if (computingTokensRef.current.has(cacheKey)) {
      computingTokensRef.current.delete(cacheKey);
      setComputingConversationIds(new Set(computingTokensRef.current.keys()));
    }
    if (
      activeConversationIdRef.current === cacheKey
      || viewingKeyRef.current === cacheKey
    ) {
      setIsChatResponding(false);
    }
    void loadConversationSummaries();
  }, [loadConversationSummaries, swarmSnapshot]);

  const stopChatResponse = useCallback(() => {
    const key = viewingKeyRef.current
      ?? (activeConversationId && ulidPattern.test(activeConversationId) ? activeConversationId : null);
    const swarm = swarmRunSnapshot();
    const swarmHere = Boolean(
      swarm.active
      && swarm.parentConversationId
      && key
      && swarm.parentConversationId === key,
    );
    if (swarmHere) stopSwarmFleet();
    if (!key) return;
    const live = liveTurnsRef.current.get(key);
    if ((!live || live.controller.signal.aborted) && !swarmHere) return;
    if (live && !live.controller.signal.aborted) {
      live.controller.abort();
      liveTurnsRef.current.delete(key);
    } else if (live) {
      liveTurnsRef.current.delete(key);
    }
    setIsChatResponding(false);
    const continuesInBackground = Boolean(live && live.runtime === "codex" && !swarmHere);
    setChatMessages((messages) => {
      const next = finalizeStreamingMessages(
        messages,
        continuesInBackground
          ? "Continuing in the background. Reopen this conversation to see the completed analysis."
          : "Stopped.",
      );
      conversationCacheRef.current.set(key, {
        messages: next,
        preferences: agentPreferencesRef.current,
        messageSequence: chatMessageSequenceRef.current,
        runtime: live?.runtime ?? "codex",
        specialistAgentId: live?.specialistAgentId ?? specialistAgentIdRef.current,
      });
      return next;
    });
    if (activeConversationId) {
      if ((!continuesInBackground || swarmHere) && computingTokensRef.current.has(activeConversationId)) {
        computingTokensRef.current.delete(activeConversationId);
        setComputingConversationIds(new Set(computingTokensRef.current.keys()));
      }
      setConversationSummaries((current) => current.map((item) => (
        item.conversationId === activeConversationId && item.lastTurnStatus === "running"
          ? { ...item, lastTurnStatus: continuesInBackground ? "running" : "cancelled" }
          : item
      )));
    }
  }, [activeConversationId]);

  const answerClarification = (answer: string, offeredTurnId?: string, optionId?: string) => {
    const text = answer.trim();
    if (!text || chatBusy) return;
    setChatClarification(null);
    setClarifyDraft("");
    void sendChatMessage(text, offeredTurnId && optionId ? { offeredTurnId, optionId } : undefined);
  };

  const beginEditUserMessage = (messageId: number, text: string) => {
    window.clearTimeout(editCloseTimerRef.current);
    setEditClosingId(null);
    setEditPanelOpen(false);
    setEditingMessageId(messageId);
    setEditDraft(text);
  };

  const cancelEditUserMessage = useCallback(() => {
    window.clearTimeout(editCloseTimerRef.current);
    const closingId = editingMessageId;
    // Restore the idle face immediately so collapse does not end with a
    // textarea→button height twitch (ThinkingTrail never swaps its header).
    setEditingMessageId(null);
    setEditDraft("");
    setEditPanelOpen(false);
    if (reduceMotion || !closingId) {
      setEditClosingId(null);
      return;
    }
    setEditClosingId(closingId);
    editCloseTimerRef.current = window.setTimeout(() => {
      setEditClosingId(null);
    }, 300);
  }, [editingMessageId, reduceMotion]);

  const resolveTurnIdForUserMessage = (messageIndex: number): string | undefined => {
    const following = chatMessages[messageIndex + 1];
    if (
      following?.role === "assistant"
      && typeof following.turnId === "string"
      && ulidPattern.test(following.turnId)
    ) {
      return following.turnId;
    }
    return undefined;
  };

  const closeEditResendConfirm = useCallback(() => {
    if (!editResendConfirm || editResendConfirmClosing || editResendBusy) return;
    if (reduceMotion) {
      setEditResendConfirm(null);
      setEditResendConfirmClosing(false);
      return;
    }
    setEditResendConfirmClosing(true);
    window.clearTimeout(editResendConfirmCloseTimerRef.current);
    editResendConfirmCloseTimerRef.current = window.setTimeout(() => {
      setEditResendConfirm(null);
      setEditResendConfirmClosing(false);
    }, 180);
  }, [editResendBusy, editResendConfirm, editResendConfirmClosing, reduceMotion]);

  const executeEditedMessageResend = async (pending: Readonly<{
    messageId: number;
    messageIndex: number;
    text: string;
    conversationId?: string;
    fromTurnId?: string;
  }>) => {
    const conversationId = pending.conversationId;
    if (conversationId && pending.fromTurnId) {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/rewind`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromTurnId: pending.fromTurnId }),
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "Albert could not rewind this conversation.");
      }
    }

    const kept = chatMessages.slice(0, pending.messageIndex);
    chatMessageSequenceRef.current = kept.reduce((max, message) => Math.max(max, message.id), 0);
    if (conversationId) {
      conversationCacheRef.current.delete(conversationId);
    }
    setTakeawaysOpen(false);
    setReasoningPanelOpen(false);

    void sendChatMessage(pending.text, undefined, {
      conversationId: conversationId ?? null,
      priorMessageCount: pending.messageIndex,
      allowWhileResponding: true,
    });
  };

  const resendEditedMessage = (messageId: number) => {
    const text = editDraft.trim();
    if (!text || editResendBusy) return;
    const messageIndex = chatMessages.findIndex(
      (message) => message.id === messageId && message.role === "user",
    );
    if (messageIndex < 0) return;

    const conversationId = activeConversationId && ulidPattern.test(activeConversationId)
      ? activeConversationId
      : undefined;
    const fromTurnId = resolveTurnIdForUserMessage(messageIndex);
    const pending = {
      messageId,
      messageIndex,
      text,
      ...(conversationId ? { conversationId } : {}),
      ...(fromTurnId ? { fromTurnId } : {}),
    };

    window.clearTimeout(editCloseTimerRef.current);
    setEditPanelOpen(false);
    setEditClosingId(null);
    setEditingMessageId(null);
    setEditDraft("");

    // Later bubbles will disappear after rewind; ask before discarding them.
    if (messageIndex < chatMessages.length - 1) {
      window.clearTimeout(editResendConfirmCloseTimerRef.current);
      setEditResendConfirmClosing(false);
      setEditResendConfirm(pending);
      return;
    }

    setEditResendBusy(true);
    void executeEditedMessageResend(pending)
      .catch((error) => {
        window.alert(error instanceof Error ? error.message : "Albert could not rerun this question.");
      })
      .finally(() => {
        setEditResendBusy(false);
      });
  };

  const confirmEditedMessageResend = async () => {
    if (!editResendConfirm || editResendBusy) return;
    setEditResendBusy(true);
    try {
      await executeEditedMessageResend(editResendConfirm);
      window.clearTimeout(editResendConfirmCloseTimerRef.current);
      setEditResendConfirm(null);
      setEditResendConfirmClosing(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Albert could not rerun this question.");
    } finally {
      setEditResendBusy(false);
    }
  };
  confirmEditedMessageResendRef.current = confirmEditedMessageResend;

  const resizeEditTextarea = useCallback(() => {
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 21), 120);
    textarea.style.height = `${nextHeight}px`;
  }, []);

  useEffect(() => () => {
    window.clearTimeout(editCloseTimerRef.current);
    window.clearTimeout(editResendConfirmCloseTimerRef.current);
  }, []);

  useEffect(() => {
    if (!editResendConfirm || editResendConfirmClosing) return;
    const frame = window.requestAnimationFrame(() => {
      editResendConfirmButtonRef.current?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditResendConfirm();
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLButtonElement && target !== editResendConfirmButtonRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void confirmEditedMessageResendRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [closeEditResendConfirm, editResendConfirm, editResendConfirmClosing]);

  // Same open pattern as ThinkingTrail: panel starts at 0fr, then opens to 1fr.
  useLayoutEffect(() => {
    if (editingMessageId === null) return;
    if (reduceMotion) {
      setEditPanelOpen(true);
      return;
    }
    setEditPanelOpen(false);
    const frame = window.requestAnimationFrame(() => {
      setEditPanelOpen(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editingMessageId, reduceMotion]);

  useEffect(() => {
    if (editingMessageId === null) return;
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    resizeEditTextarea();
    textarea.focus();
    const length = textarea.value.length;
    textarea.setSelectionRange(length, length);
  }, [editingMessageId, resizeEditTextarea]);

  useLayoutEffect(() => {
    if (editingMessageId === null) return;
    resizeEditTextarea();
  }, [editDraft, editingMessageId, resizeEditTextarea]);

  useEffect(() => {
    if (editingMessageId === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (editComposerRef.current?.contains(target)) return;
      cancelEditUserMessage();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [cancelEditUserMessage, editingMessageId]);

  const resetChat = (
    runtime: Exclude<ChatRuntime, "fixture">,
    nextSpecialistAgentId: SpecialistAgentId = "general",
  ) => {
    snapshotViewedConversation();
    chatPinAnimationsRef.current.forEach((animation) => animation.stop());
    chatPinAnimationsRef.current = [];
    if (chatPinTimerRef.current !== undefined) {
      window.clearTimeout(chatPinTimerRef.current);
      chatPinTimerRef.current = undefined;
    }
    lastPinnedUserMessageIdRef.current = null;
    composerOriginTopRef.current = null;
    shouldAnimatePinRef.current = false;
    setOpeningConversationId(null);
    setConversationSkelPhase("idle");
    setConversationSkelRevealed(false);
    setConversationSkelResetting(false);
    if (composerExpandTimerRef.current !== undefined) {
      window.clearTimeout(composerExpandTimerRef.current);
      composerExpandTimerRef.current = undefined;
    }
    setActiveItem("Chat");
    setChatMessages([]);
    setActiveConversationId(undefined);
    activeConversationIdRef.current = undefined;
    setActiveChatRuntime(runtime);
    activeChatRuntimeRef.current = runtime;
    setSpecialistAgentId(nextSpecialistAgentId);
    specialistAgentIdRef.current = nextSpecialistAgentId;
    setAgentsOpen(false);
    viewingKeyRef.current = null;
    chatMessageSequenceRef.current = 0;
    setChatDraft("");
    setIsChatResponding(false);
    setComposerExpanded(false);
    setTakeawaysOpen(false);
    setReasoningPanelOpen(false);
    setSwarmPanelOpen(false);
    if (runtime !== "codex") setSwarmMode(false);
    setChatClarification(null);
    setClarifyDraft("");
    setEditingMessageId(null);
    setEditDraft("");
  };

  // New Analysis leaves specialist mode and returns to Codex, while
  // preserving an explicitly selected connector test runtime.
  const startNewChat = () => {
    if (activeChatRuntimeRef.current === "xero_mcp") {
      resetChat("xero_mcp", "general");
      return;
    }
    setAgentPreferences(DEFAULT_AGENT_PREFERENCES);
    agentPreferencesRef.current = DEFAULT_AGENT_PREFERENCES;
    setCodexSolPlannerEnabled(DEFAULT_CODEX_SOL_PLANNER);
    codexSolPlannerEnabledRef.current = DEFAULT_CODEX_SOL_PLANNER;
    setCodexProModeEnabled(DEFAULT_CODEX_PRO_MODE);
    codexProModeEnabledRef.current = DEFAULT_CODEX_PRO_MODE;
    resetChat("codex", "general");
  };
  const startCustomerChat = () => {
    resetChat("v3", "customers");
    window.requestAnimationFrame(() => chatTextareaRef.current?.focus());
  };
  const startCodexChat = () => {
    setAgentPreferences(DEFAULT_AGENT_PREFERENCES);
    agentPreferencesRef.current = DEFAULT_AGENT_PREFERENCES;
    setCodexSolPlannerEnabled(DEFAULT_CODEX_SOL_PLANNER);
    codexSolPlannerEnabledRef.current = DEFAULT_CODEX_SOL_PLANNER;
    setCodexProModeEnabled(DEFAULT_CODEX_PRO_MODE);
    codexProModeEnabledRef.current = DEFAULT_CODEX_PRO_MODE;
    resetChat("codex", "general");
    window.requestAnimationFrame(() => chatTextareaRef.current?.focus());
  };
  const startCompareChat = () => {
    resetChat("compare", "general");
  };
  const startSalesDeepSwarm = () => {
    if (swarmRunSnapshot().active) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("view") === "Agents") {
      url.searchParams.delete("view");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setAgentPreferences(SALES_DEEP_PREFERENCES);
    agentPreferencesRef.current = SALES_DEEP_PREFERENCES;
    resetChat("codex", "general");
    setSwarmMode(true);
    void sendChatMessage(SALES_DEEP_OWNER_QUESTION, undefined, {
      conversationId: null,
      priorMessageCount: 0,
      allowWhileResponding: true,
      preferencesOverride: SALES_DEEP_PREFERENCES,
      swarmKind: "sales-deep",
    });
  };
  const selectConversationRuntime = (tab: ConversationRuntimeTab) => {
    if (tab === "compare") {
      if (activeChatRuntimeRef.current !== "compare") startCompareChat();
      return;
    }
    if (tab === "codex") {
      if (activeChatRuntimeRef.current !== "codex") startCodexChat();
      return;
    }
    if (activeChatRuntimeRef.current === "codex" || activeChatRuntimeRef.current === "compare") {
      resetChat("v3", "general");
      window.requestAnimationFrame(() => chatTextareaRef.current?.focus());
    }
  };
  const startNewChatRef = useRef(startNewChat);
  startNewChatRef.current = startNewChat;

  useEffect(() => {
    const openNewChat = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.code !== "KeyN" && event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      startNewChatRef.current();
    };
    document.addEventListener("keydown", openNewChat);
    return () => document.removeEventListener("keydown", openNewChat);
  }, []);

  const updateConversationSidebarPrefs = (
    updater: (current: ConversationSidebarPrefs) => ConversationSidebarPrefs,
  ) => {
    setConversationSidebarPrefs((current) => {
      const next = updater(current);
      saveConversationSidebarPrefs(accountEmail, next);
      return next;
    });
  };

  const toggleConversationGroupCollapsed = (groupKey: string) => {
    setCollapsedConversationGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const togglePinnedConversation = (conversationId: string) => {
    updateConversationSidebarPrefs((current) => {
      const isPinned = current.pinnedIds.includes(conversationId);
      return {
        ...current,
        pinnedIds: isPinned
          ? current.pinnedIds.filter((id) => id !== conversationId)
          : [conversationId, ...current.pinnedIds.filter((id) => id !== conversationId)],
      };
    });
  };

  const archiveConversation = (conversationId: string) => {
    updateConversationSidebarPrefs((current) => ({
      archivedIds: current.archivedIds.includes(conversationId)
        ? current.archivedIds
        : [...current.archivedIds, conversationId],
      pinnedIds: current.pinnedIds.filter((id) => id !== conversationId),
    }));
    if (conversationId === activeConversationId) {
      startNewChat();
    }
  };

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setAccountError("");
    setIsSigningOut(true);

    const { error } = await supabase.auth.signOut();

    if (error) {
      setAccountError("Albert could not sign you out. Please try again.");
      setIsSigningOut(false);
      return;
    }

    router.replace("/login");
    router.refresh();
  };

  const pinTableToDashboard = async (
    conversationId: string,
    turnId: string,
    table: TraceTableEvent,
  ): Promise<void> => {
    const loadRevision = async () => {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as {
        dashboard?: { revision?: number };
        error?: string;
      } | null;
      if (!response.ok || typeof payload?.dashboard?.revision !== "number") {
        throw new Error(payload?.error ?? "Dashboard is unavailable.");
      }
      dashboardRevisionRef.current = payload.dashboard.revision;
      return payload.dashboard.revision;
    };
    const submit = async (expectedRevision: number) => {
      const response = await fetch("/api/dashboard/tiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          turnId,
          tableEventId: table.id,
          resultId: table.resultId,
          expectedRevision,
        }),
      });
      const payload = await response.json().catch(() => null) as {
        dashboard?: { revision?: number };
        error?: string;
      } | null;
      if (typeof payload?.dashboard?.revision === "number") {
        dashboardRevisionRef.current = payload.dashboard.revision;
      }
      return { response, payload };
    };

    const revision = dashboardRevisionRef.current ?? await loadRevision();
    let result = await submit(revision);
    if (result.response.status === 409 && typeof result.payload?.dashboard?.revision === "number") {
      result = await submit(result.payload.dashboard.revision);
    }
    if (!result.response.ok || typeof result.payload?.dashboard?.revision !== "number") {
      throw new Error(result.payload?.error ?? "The table could not be added to Dashboard.");
    }
  };

  const renderChatTurns = () => {
    const turns: Array<{ user: ChatMessage | null; replies: ChatMessage[] }> = [];
    for (const message of chatMessages) {
      if (message.role === "user") {
        turns.push({ user: message, replies: [] });
        continue;
      }
      if (turns.length === 0) {
        turns.push({ user: null, replies: [message] });
        continue;
      }
      turns[turns.length - 1]!.replies.push(message);
    }
    return turns.map((turn) => {
      const turnKey = `${activeConversationId ?? "draft"}:turn:${turn.user?.id ?? turn.replies[0]?.id ?? "empty"}`;
      return (
        <div className={styles.chatTurn} key={turnKey}>
          {turn.user ? (() => {
            const message = turn.user!;
            const suppressEnter = Boolean(reduceMotion || message.suppressEnter);
            const messageKey = `${activeConversationId ?? "draft"}:${message.id}`;
            const isEditing = editingMessageId === message.id;
            const isEditClosing = editClosingId === message.id;
            // Keep trailing mounted while collapsing so 0fr has real height to animate.
            const showEditChrome = isEditing || isEditClosing;
            // Same single open flag as ThinkingTrail: drives radius + panel together.
            const editOpen = isEditing && editPanelOpen;
            const turnComputing = turn.replies.some((reply) => Boolean(reply.isStreaming));
            const orbTheme = theme === "light" || theme === "beige" || theme === "sage"
              ? "light" as const
              : theme === "dark" || theme === "green"
                ? "dark" as const
                : "auto" as const;
            return (
              <motion.div
                className={styles.chatUserBlock}
                data-message-id={message.id}
                key={messageKey}
                initial={suppressEnter ? false : { opacity: 0 }}
                animate={suppressEnter ? undefined : { opacity: 1 }}
                transition={{
                  duration: 0.34,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                <div
                  ref={showEditChrome ? editComposerRef : undefined}
                  className={`${styles.chatMessage} ${styles.chatMessageUser} ${styles.chatMessageUserShell}${!isEditing && turnComputing ? ` ${styles.chatMessageUserComputing}` : ""}`}
                  data-edit-open={editOpen ? "true" : "false"}
                  style={{ borderRadius: editOpen ? 12 : 14 }}
                >
                  {isEditing ? (
                    <textarea
                      ref={editTextareaRef}
                      className={styles.chatMessageEditInput}
                      aria-label="Edit message"
                      rows={1}
                      value={editDraft}
                      onChange={(event) => {
                        setEditDraft(event.target.value);
                        window.requestAnimationFrame(() => resizeEditTextarea());
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelEditUserMessage();
                          return;
                        }
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          resendEditedMessage(message.id);
                        }
                      }}
                    />
                  ) : (
                    <CollapsibleUserQuestion
                      text={message.text}
                      onEdit={() => beginEditUserMessage(message.id, message.text)}
                      orb={turnComputing ? (
                        <span className={styles.chatMessageUserOrb} aria-hidden="true">
                          <ThinkingOrb
                            className={styles.conversationItemOrb}
                            state="solving"
                            size={20}
                            speed={1.5}
                            paused={Boolean(reduceMotion)}
                            theme={orbTheme}
                            aria-label="Computing"
                          />
                        </span>
                      ) : null}
                    />
                  )}
                  {/* Identical expand method to ThinkingTrail. */}
                  <div
                    className={traceStyles.expandPanel}
                    style={{
                      gridTemplateRows: editOpen ? "1fr" : "0fr",
                      opacity: editOpen ? 1 : 0,
                    }}
                    data-duration="300"
                  >
                    <div className={traceStyles.expandInner}>
                      {showEditChrome ? (
                        <div className={styles.chatMessageEditTrailing}>
                          {activeChatRuntime === "codex" ? (
                            <ModelRunControls
                              value={agentPreferences}
                              onChange={setAgentPreferences}
                              allowedModelIds={CODEX_MODEL_IDS}
                              allowedReasoningEfforts={CODEX_REASONING_EFFORTS}
                              solPlannerEnabled={codexSolPlannerEnabled}
                              onSolPlannerChange={setCodexSolPlannerEnabled}
                              proModeEnabled={codexProModeEnabled}
                              onProModeChange={setCodexProModeEnabled}
                              popoverPlacement="below"
                              popoverAlign="shell-start"
                            />
                          ) : activeChatRuntime === "anthropic" ? (
                            <span className={styles.chatRuntimeIndicator}>Claude Opus 5</span>
                          ) : activeChatRuntime === "cubecore" ? (
                            <span className={styles.chatRuntimeIndicator}>Cubecore</span>
                          ) : activeChatRuntime === "xero_mcp" ? (
                            <span className={styles.chatRuntimeIndicator}>Xero MCP</span>
                          ) : (
                            <ModelRunControls
                              value={agentPreferences}
                              onChange={setAgentPreferences}
                              allowedModelIds={V3_MODEL_IDS}
                              popoverPlacement="below"
                              popoverAlign="shell-start"
                            />
                          )}
                          <button
                            className={styles.chatMessageEditSend}
                            type="button"
                            aria-label="Resend message"
                            disabled={!isEditing || !editDraft.trim()}
                            onClick={() => resendEditedMessage(message.id)}
                          >
                            <Icon name="arrowUp" />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })() : null}
          {turn.replies.map((message) => {
            const suppressEnter = Boolean(reduceMotion || message.suppressEnter);
            const messageKey = `${activeConversationId ?? "draft"}:${message.id}`;
            return (
              <motion.article
                className={`${styles.chatMessage} ${styles.chatMessageAssistant}`}
                data-message-id={message.id}
                key={messageKey}
                initial={suppressEnter ? false : { opacity: 0 }}
                animate={suppressEnter ? undefined : { opacity: 1 }}
                transition={{
                  duration: 0.34,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                {message.events?.length || message.isStreaming ? (
                  message.trailVisible === false ? (
                    <div className={styles.chatTrailDeferred} aria-hidden="true" />
                  ) : (
                    <InsightsStyleTrace
                      events={message.events ?? []}
                      streaming={message.isStreaming}
                      detailedMode={chatDetailedMode}
                      runtime={message.runtime}
                      lineageReference={message.conversationId && message.turnId ? {
                        conversationId: message.conversationId,
                        turnId: message.turnId,
                      } : undefined}
                      onFollowUp={(prompt) => void sendChatMessage(prompt)}
                      onAddToChat={(text) => {
                        setChatDraft((current) => {
                          const trimmed = current.trim();
                          return trimmed ? `${trimmed}\n\n${text}` : text;
                        });
                        window.requestAnimationFrame(() => {
                          const field = chatTextareaRef.current;
                          if (!field) return;
                          field.focus();
                          const end = field.value.length;
                          field.setSelectionRange(end, end);
                          resizeComposerTextarea();
                        });
                      }}
                      onAddToDashboard={message.conversationId && message.turnId
                        ? (table) => pinTableToDashboard(message.conversationId!, message.turnId!, table)
                        : undefined}
                      onClarification={(label, optionId) => answerClarification(label, message.turnId, optionId)}
                    />
                  )
                ) : (
                  <span className={styles.chatMessageLabel}>Albert</span>
                )}
              </motion.article>
            );
          })}
        </div>
      );
    });
  };

  return (
    <main
      className={`${styles.dash} ${collapsed ? styles.collapsed : ""}`}
      data-theme={theme}
    >
      <aside className={`${styles.sidebar} ${accountOpen ? styles.sidebarAccountMenuOpen : ""} ${agentsOpen ? styles.sidebarAgentsMenuOpen : ""}`}>
        <div className={styles.sidebarHeader}>
          <div className={styles.projectBrand}>
            <Image
              className={styles.projectLogo}
              src="/logos/albert.png"
              alt=""
              width={20}
              height={20}
              unoptimized
            />
            <span className={styles.projectName}>
              <span className={styles.projectNameAlbert}>Albert</span>
              <span className={styles.projectNameProduct}>Analytics</span>
            </span>
          </div>
          <button
            ref={collapseButtonRef}
            className={`${styles.collapseButton} ${!collapsed || collapseIconSwapArmed ? styles.collapseButtonHot : ""}`}
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => {
              setCollapseIconSwapArmed(false);
              collapseSwapArmPendingRef.current = false;
              if (collapseSwapArmTimerRef.current !== undefined) {
                window.clearTimeout(collapseSwapArmTimerRef.current);
                collapseSwapArmTimerRef.current = undefined;
              }
              setCollapsed((value) => {
                const next = !value;
                if (next) {
                  // Match sidebar width transition (720ms) so layout hit-testing
                  // flicker does not arm hover chrome mid-collapse.
                  collapseSwapArmTimerRef.current = window.setTimeout(() => {
                    collapseSwapArmTimerRef.current = undefined;
                    if (!collapseSwapArmPendingRef.current) return;
                    collapseSwapArmPendingRef.current = false;
                    if (collapseButtonRef.current?.matches(":hover")) return;
                    setCollapseIconSwapArmed(true);
                  }, 740);
                }
                return next;
              });
            }}
            onPointerLeave={() => {
              if (!collapsed) return;
              if (collapseSwapArmTimerRef.current !== undefined) {
                collapseSwapArmPendingRef.current = true;
                return;
              }
              setCollapseIconSwapArmed(true);
            }}
            onBlur={() => {
              if (!collapsed) return;
              if (collapseSwapArmTimerRef.current !== undefined) {
                collapseSwapArmPendingRef.current = true;
                return;
              }
              setCollapseIconSwapArmed(true);
            }}
          >
            {collapsed ? (
              <span
                className={`${styles.collapseIconSwap} ${collapseIconSwapArmed ? styles.collapseIconSwapArmed : ""}`}
                data-state="a"
                aria-hidden="true"
              >
                <span className={styles.collapseIconSwapFace} data-icon="a">
                  <Image
                    className={styles.collapseButtonLogo}
                    src="/logos/albert.png"
                    alt=""
                    width={20}
                    height={20}
                    unoptimized
                  />
                </span>
                <span className={styles.collapseIconSwapFace} data-icon="b">
                  <Icon name="panel" />
                </span>
              </span>
            ) : (
              <Icon name="panel" />
            )}
          </button>
        </div>

        <div className={styles.sidebarActions}>
          <button
            className={styles.sidebarAction}
            type="button"
            aria-label="New Analysis"
            aria-keyshortcuts="Alt+N"
            onClick={startNewChat}
          >
            <Icon name="plus" />
            <span className={styles.sidebarActionLabel}>New Analysis</span>
          </button>
          <button
            className={styles.sidebarAction}
            type="button"
            aria-label="Agents"
            aria-current={activeItem === "Agents" ? "page" : undefined}
            onClick={() => {
              setAgentsOpen(false);
              setActiveItem("Agents");
            }}
          >
            <Icon name="agents" />
            <span className={styles.sidebarActionLabel}>Agents</span>
          </button>
          {canUseCustomerAgent ? (
            <div hidden className={styles.sidebarAgents} ref={agentsAreaRef}>
              <button
                ref={agentsTriggerRef}
                className={`${styles.sidebarAction} ${styles.sidebarAgentsTrigger}`}
                type="button"
                aria-label="Agents"
                aria-haspopup="menu"
                aria-expanded={agentsOpen}
                aria-controls="sidebar-agents-menu"
                aria-current={isCustomerAgent && activeItem === "Chat" ? "page" : undefined}
                onClick={() => {
                  setAccountOpen(false);
                  setAgentsOpen((current) => !current);
                }}
              >
                <Icon name="agents" />
                <span className={styles.sidebarActionLabel}>Agents</span>
                <Icon className={styles.sidebarAgentsChevron} name="chevronDown" />
              </button>
              <div
                ref={agentsPopoverRef}
                id="sidebar-agents-menu"
                className={`${styles.sidebarAgentsPopover} ${agentsOpen ? styles.sidebarAgentsPopoverOpen : ""}`}
                role="menu"
                aria-label="Specialist agents"
                aria-hidden={!agentsOpen}
                inert={!agentsOpen}
              >
                <p className={styles.sidebarAgentsHeading}>Specialists</p>
                <button
                  className={styles.sidebarAgentOption}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isCustomerAgent}
                  onClick={startCustomerChat}
                >
                  <span className={styles.sidebarAgentOptionIcon} aria-hidden="true">
                    <Icon name="agents" />
                  </span>
                  <span className={styles.sidebarAgentOptionCopy}>
                    <strong>{customerSpecialistAgent.ui.navigationLabel}</strong>
                    <small>{customerSpecialistAgent.ui.description}</small>
                  </span>
                  <span className={styles.sidebarAgentOptionStatus} aria-hidden="true">
                    {isCustomerAgent ? "✓" : ""}
                  </span>
                </button>
              </div>
            </div>
          ) : null}
          <button
            className={styles.sidebarAction}
            type="button"
            aria-label="Proactive"
            aria-current={activeItem === "Proactive" ? "page" : undefined}
            onClick={() => setActiveItem("Proactive")}
          >
            <Icon name="radar" />
            <span className={styles.sidebarActionLabel}>Proactive</span>
          </button>
          <button
            hidden
            className={styles.sidebarAction}
            type="button"
            aria-label="Dashboard"
            aria-current={activeItem === "Dashboard" ? "page" : undefined}
            onClick={() => setActiveItem("Dashboard")}
          >
            <Icon name="dashboard" />
            <span className={styles.sidebarActionLabel}>Dashboard</span>
          </button>
          <button
            className={styles.sidebarAction}
            type="button"
            aria-label="My Data"
            aria-current={activeItem === "My Data" ? "page" : undefined}
            onClick={() => setActiveItem("My Data")}
          >
            <Icon name="database" />
            <span className={styles.sidebarActionLabel}>My Data</span>
          </button>
          <button
            hidden
            className={styles.sidebarAction}
            type="button"
            aria-label="Test chart"
            aria-current={activeItem === "Test chart" ? "page" : undefined}
            onClick={() => setActiveItem("Test chart")}
          >
            <Icon name="chart" />
            <span className={styles.sidebarActionLabel}>Test chart</span>
          </button>
          <button
            className={styles.sidebarAction}
            type="button"
            aria-label="New test"
            aria-current={activeItem === "New test" ? "page" : undefined}
            onClick={() => setActiveItem("New test")}
          >
            <Icon name="chat" />
            <span className={styles.sidebarActionLabel}>New test</span>
          </button>
          {canViewQueryLogs ? (
            <button
              className={styles.sidebarAction}
              type="button"
              aria-label="Logs"
              aria-current={activeItem === "Logs" ? "page" : undefined}
              onClick={() => setActiveItem("Logs")}
            >
              <Icon name="logs" />
              <span className={styles.sidebarActionLabel}>Logs</span>
            </button>
          ) : null}
          <label className={`${styles.sidebarAction} ${styles.sidebarSearchAction} ${sidebarSearchOpen || query ? styles.sidebarSearchActionOpen : ""}`}>
            <Icon name="search" />
            <input
              ref={searchInputRef}
              aria-label="Search"
              aria-keyshortcuts="Meta+K Control+K"
              placeholder="Search"
              value={query}
              onFocus={() => setSidebarSearchOpen(true)}
              onBlur={() => {
                if (!query.trim()) setSidebarSearchOpen(false);
              }}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        <nav
          className={`${styles.conversationNav} ${sidebarNavRevealed ? styles.conversationNavRevealed : ""}`}
          aria-label="Conversations"
        >
          {conversationHistoryStatus.kind === "loading" && conversationSummaries.length === 0 ? (
            <div
              className={styles.conversationNavSkeleton}
              role="status"
              aria-label="Loading conversations"
              data-state="loading"
            >
              <div className={`${styles.conversationNavSkeletonLayer} ${styles.isPulsing}`}>
                <div className={styles.conversationNavSkeletonItem} />
                <div className={styles.conversationNavSkeletonItem} data-width="mid" />
                <div className={styles.conversationNavSkeletonItem} data-width="short" />
                <div className={styles.conversationNavSkeletonItem} />
                <div className={styles.conversationNavSkeletonItem} data-width="mid" />
              </div>
            </div>
          ) : conversationHistoryStatus.kind === "error" && conversationSummaries.length === 0 ? (
            <div className={styles.conversationNavState} role="alert">
              <p>{conversationHistoryStatus.message}</p>
              <button type="button" onClick={() => void loadConversationSummaries()}>Try again</button>
            </div>
          ) : filteredConversations.length === 0 ? (
            <p className={styles.conversationNavState}>
              {query.trim() ? "No matches" : "Your analyses will appear here after the first question."}
            </p>
          ) : (
            <div className={styles.conversationLibrary}>
              <div className={styles.conversationLibraryHeader}>Analysis</div>
              {conversationGroups.map((group) => {
                const isGroupCollapsed = collapsedConversationGroups.has(group.key);
                return (
                <div className={styles.conversationGroup} key={group.key}>
                  <button
                    className={`${styles.conversationDayHeader} ${isGroupCollapsed ? styles.conversationDayHeaderCollapsed : ""}`}
                    type="button"
                    aria-expanded={!isGroupCollapsed}
                    aria-controls={`conversation-group-${group.key}`}
                    onClick={() => toggleConversationGroupCollapsed(group.key)}
                  >
                    <span className={styles.conversationDayHeaderIcon} aria-hidden="true">
                      <Icon
                        className={styles.conversationDayHeaderGlyph}
                        name={group.kind === "pinned" ? "pin" : "calendar"}
                      />
                      <Icon className={styles.conversationDayHeaderChevron} name="chevronDown" />
                    </span>
                    <span>{group.label}</span>
                  </button>
                  <AnimatePresence initial={false}>
                    {!isGroupCollapsed ? (
                      <motion.div
                        className={styles.conversationList}
                        id={`conversation-group-${group.key}`}
                        key={`${group.key}-list`}
                        initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={
                          reduceMotion
                            ? undefined
                            : {
                                height: 0,
                                opacity: 0,
                                transition: {
                                  duration: 0.26,
                                  ease: [0.04, 0.62, 0.23, 0.98],
                                },
                              }
                        }
                        transition={{
                          duration: reduceMotion ? 0 : 0.4,
                          ease: [0.04, 0.62, 0.23, 0.98],
                        }}
                        style={{ overflow: "hidden" }}
                      >
                    <AnimatePresence initial={false}>
                    {group.items.map((conversation) => {
                      const isActive = conversation.conversationId === activeConversationId && activeItem === "Chat";
                      const isPinned = pinnedConversationIdSet.has(conversation.conversationId);
                      const isComputing = computingConversationIds.has(conversation.conversationId);
                      const isUnread = !isComputing
                        && !isActive
                        && unreadConversationIds.has(conversation.conversationId);
                      const isNewSidebarItem = !seenSidebarConversationIdsRef.current.has(
                        conversation.conversationId,
                      );
                      return (
                        <motion.div
                          className={`${styles.conversationItem} ${isActive ? styles.conversationItemActive : ""} ${isPinned ? styles.conversationItemPinned : ""}`}
                          key={conversation.conversationId}
                          initial={
                            reduceMotion || !isNewSidebarItem
                              ? false
                              : { height: 0, opacity: 0, y: -10 }
                          }
                          animate={{ height: "auto", opacity: 1, y: 0 }}
                          exit={
                            reduceMotion
                              ? undefined
                              : {
                                  height: 0,
                                  opacity: 0,
                                  y: -6,
                                  transition: {
                                    duration: 0.26,
                                    ease: [0.04, 0.62, 0.23, 0.98],
                                  },
                                }
                          }
                          transition={{
                            duration: reduceMotion ? 0 : 0.4,
                            ease: [0.04, 0.62, 0.23, 0.98],
                          }}
                          style={{ overflow: "hidden" }}
                          onPointerEnter={() => void prefetchConversation(conversation.conversationId)}
                        >
                          <button
                            className={styles.conversationItemOpen}
                            type="button"
                            aria-current={isActive ? "page" : undefined}
                            onFocus={() => void prefetchConversation(conversation.conversationId)}
                            onClick={() => void openSavedConversation(conversation.conversationId)}
                          >
                            <span
                              className={styles.conversationItemLead}
                              aria-hidden={!(isComputing || isUnread)}
                            >
                              {isComputing ? (
                                <ThinkingOrb
                                  className={styles.conversationItemOrb}
                                  state="solving"
                                  size={20}
                                  speed={1.5}
                                  paused={Boolean(reduceMotion)}
                                  theme={
                                    theme === "light" || theme === "beige" || theme === "sage"
                                      ? "light"
                                      : theme === "dark" || theme === "green"
                                        ? "dark"
                                        : "auto"
                                  }
                                  aria-label="Computing"
                                />
                              ) : isUnread ? (
                                <span
                                  className={styles.conversationItemUnread}
                                  role="status"
                                  aria-label="Unread analysis ready"
                                />
                              ) : null}
                            </span>
                            <span className={styles.conversationItemMain}>
                              <span className={styles.conversationItemTitleRow}>
                                <AnimatePresence mode="wait" initial={false}>
                                  <motion.span
                                    key={conversation.title}
                                    className={styles.conversationItemTitleText}
                                    initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
                                    transition={{
                                      duration: reduceMotion ? 0 : 0.34,
                                      ease: [0.22, 1, 0.36, 1],
                                    }}
                                  >
                                    {formatConversationTitle(conversation.title)}
                                  </motion.span>
                                </AnimatePresence>
                              </span>
                            </span>
                          </button>
                          <div className={styles.conversationItemMeta}>
                            <div className={styles.conversationItemActions}>
                              <button
                                className={`${styles.conversationItemAction} ${isPinned ? styles.conversationItemActionActive : ""}`}
                                type="button"
                                aria-label={isPinned ? "Unpin conversation" : "Pin conversation"}
                                aria-pressed={isPinned}
                                data-tooltip={isPinned ? "Unpin" : "Pin"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  togglePinnedConversation(conversation.conversationId);
                                }}
                              >
                                <Icon name="pin" />
                              </button>
                              <button
                                className={styles.conversationItemAction}
                                type="button"
                                aria-label="Archive conversation"
                                data-tooltip="Archive"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  archiveConversation(conversation.conversationId);
                                }}
                              >
                                <Icon name="archive" />
                              </button>
                            </div>
                            <time className={styles.conversationItemTime} dateTime={conversation.updatedAt}>
                              {relativeConversationTime(conversation.updatedAt)}
                            </time>
                          </div>
                        </motion.div>
                      );
                    })}
                    </AnimatePresence>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
                );
              })}
            </div>
          )}
        </nav>

        <div className={styles.accountArea} ref={accountAreaRef}>
          {/* Sidebar sync status card hidden for now. */}
          {false && sidebarSyncDomains.length > 0 && !sidebarSyncFullyComplete ? (
            <div className={styles.sidebarSync}>
              <div className={styles.sidebarSyncTop}>
                <span>
                  {sidebarSyncActive
                    ? "Syncing..."
                    : readinessStateLabels[sidebarSyncSummary.state]}
                </span>
                <strong>
                  {typeof sidebarSyncSummary.progress === "number"
                    ? `${sidebarSyncSummary.progress}%`
                    : ""}
                </strong>
              </div>
              <ConnectionSyncProgress
                accountLabel={accountOrganisation.name}
                domains={sidebarSyncDomains}
                popupPlacement="above"
                layout="sidebar"
              />
              <div className={styles.sidebarSyncCommentary} aria-live="polite">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={sidebarSyncCommentary[
                      sidebarSyncCommentaryIndex % sidebarSyncCommentary.length
                    ] ?? "sync-status"}
                    className={styles.sidebarSyncCommentaryLine}
                    initial={reduceMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={reduceMotion ? undefined : { opacity: 0 }}
                    transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
                  >
                    {sidebarSyncCommentary[
                      sidebarSyncCommentaryIndex % sidebarSyncCommentary.length
                    ]}
                  </motion.p>
                </AnimatePresence>
              </div>
            </div>
          ) : null}
          <div
            className={`${styles.accountPopover} ${accountOpen ? styles.accountPopoverOpen : ""}`}
            ref={accountPopoverRef}
            role="dialog"
            aria-label="Account menu"
            aria-hidden={!accountOpen}
            inert={!accountOpen}
          >
            <p className={styles.accountEmail}>{accountEmail || "Signed in"}</p>
            {accountError ? <p className={styles.accountError} role="alert">{accountError}</p> : null}
            <div className={styles.themeSwitcher} aria-label="Theme" role="group">
              {themeOptions.map((option) => (
                <button
                  className={theme === option.value ? styles.themeActive : ""}
                  key={option.value}
                  type="button"
                  aria-label={option.label}
                  aria-pressed={theme === option.value}
                  onClick={() => setThemePreference(option.value)}
                >
                  <Icon name={option.icon} />
                </button>
              ))}
            </div>

            <div className={styles.accountDivider} />

            <div className={styles.accountLinks}>
              <button
                type="button"
                onClick={() => {
                  setActiveItem("Connections");
                  setAccountOpen(false);
                }}
              ><Icon name="connections" /><span>Connections</span></button>
              <button
                type="button"
                onClick={() => {
                  setActiveItem("Organization");
                  setAccountOpen(false);
                }}
              ><Icon name="organization" /><span>Organization settings</span></button>
              <button
                type="button"
                onClick={() => {
                  setActiveItem("BusinessContext");
                  setAccountOpen(false);
                }}
              ><Icon name="organization" /><span>About your business</span></button>
              <button
                type="button"
                onClick={() => {
                  setActiveItem("SemanticMemory");
                  setAccountOpen(false);
                }}
              ><Icon name="settings" /><span>Albert&apos;s memory</span></button>
              {isInternalOperator ? (
                <button
                  type="button"
                  onClick={() => {
                    setActiveItem("Admin");
                    setAccountOpen(false);
                  }}
                ><Icon name="logs" /><span>Admin</span></button>
              ) : null}
            </div>

            <div className={styles.accountDivider} />

            <button
              className={styles.logoutButton}
              type="button"
              onClick={handleSignOut}
              disabled={isSigningOut}
            >
              <Icon name="logout" />
              <span>{isSigningOut ? "Logging out…" : "Log out"}</span>
            </button>
          </div>

          <div className={styles.accountBar}>
            <button
              ref={accountTriggerRef}
              className={styles.accountTrigger}
              type="button"
              aria-label={`${accountOrganisation.name} account menu`}
              aria-expanded={accountOpen}
              aria-haspopup="dialog"
              onClick={() => {
                setAgentsOpen(false);
                setAccountOpen((value) => !value);
              }}
            >
              <span className={styles.accountAvatar}>{accountInitial}</span>
              <span className={styles.accountWorkspaceCopy}>
                <strong>{accountOrganisation.name}</strong>
                <small>{accountRoleLabel}</small>
              </span>
            </button>
            <button
              className={styles.accountSettingsButton}
              type="button"
              aria-label="Organisation settings"
              title="Settings"
              onClick={() => {
                setActiveItem("Organization");
                setAccountOpen(false);
              }}
            >
              <Icon name="settings" />
            </button>
          </div>
        </div>
      </aside>

      <section className={styles.content} aria-labelledby="dash-title">
        {activeItem !== "Chat" ? (
          <header className={`${styles.pageHeader} ${styles.pageHeaderSimple}`}>
            <div className={styles.pageHeaderTop}>
              <h1 id="dash-title">{activeItem === "SemanticMemory" ? "Albert's memory" : activeItem === "BusinessContext" ? "About your business" : activeItem}</h1>
            </div>
          </header>
        ) : null}
        {tenantDeletionReceipt ? (
          <TenantDeletionWorkspace initialReceipt={tenantDeletionReceipt} />
        ) : activeItem === "Chat" && activeChatRuntime === "compare" ? (
          <RuntimeComparisonWorkspace
            organisationName={accountOrganisation.name}
            onSelectRuntime={selectConversationRuntime}
            onConversationsChanged={loadConversationSummaries}
          />
        ) : activeItem === "Chat" ? (
          <div
            className={`${styles.chatShell} ${sidePanelOpen ? styles.chatShellTakeawaysOpen : ""} ${swarmPanelResizing ? styles.chatShellTakeawaysResizing : ""}`}
            style={swarmPanelOpen ? { ["--takeaways-panel-width" as string]: `${swarmPanelWidth}px` } : undefined}
          >
          <div className={styles.chatWorkspace} ref={chatWorkspaceRef}>
            <header className={styles.chatTopBar}>
              <div className={styles.chatTopIdentity}>
                {isCustomerAgent ? (
                  <>
                    <span className={styles.chatSpecialistContext}>
                      {activeSpecialistAgent.ui.navigationLabel} · {accountOrganisation.name}
                    </span>
                    <span className={styles.chatSpecialistContextDivider} aria-hidden="true" />
                  </>
                ) : null}
                <AnimatePresence mode="wait" initial={false}>
                  <motion.h1
                    key={`${activeChatRuntime}:${specialistAgentId}:${chatTitle}`}
                    id="dash-title"
                    className={styles.chatTopTitle}
                    initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.34,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    {chatTitle}
                  </motion.h1>
                </AnimatePresence>
              </div>
              <div className={styles.chatTopActions}>
                <ConversationRuntimeTabs
                  value={activeChatRuntime === "codex" ? "codex" : "albert"}
                  onChange={selectConversationRuntime}
                />
                {chatMessages.length > 0 ? (
                  <button
                    className={`${styles.chatTakeawaysToggle} ${chatDetailedMode ? styles.chatTakeawaysToggleActive : ""}`}
                    type="button"
                    aria-label="Detailed mode"
                    aria-pressed={chatDetailedMode}
                    title={chatDetailedMode ? "Hide detailed mode" : "Show detailed mode"}
                    onClick={() => setChatDetailedMode((current) => !current)}
                  >
                    <Icon name="list" />
                  </button>
                ) : null}
                {activeChatRuntime === "codex" && chatMessages.length > 0 ? (
                  <button
                    className={`${styles.chatTakeawaysToggle} ${styles.chatReasoningToggle} ${reasoningPanelOpen ? styles.chatTakeawaysToggleActive : ""}`}
                    type="button"
                    aria-label={reasoningPanelOpen ? "Hide reasoning" : "Show reasoning"}
                    aria-pressed={reasoningPanelOpen}
                    aria-controls="analysis-takeaways"
                    title={reasoningPanelOpen ? "Hide reasoning" : "Show OpenAI reasoning summary"}
                    onClick={() => {
                      setReasoningPanelOpen((open) => {
                        if (!open) {
                          setTakeawaysOpen(false);
                          setSwarmPanelOpen(false);
                        }
                        return !open;
                      });
                    }}
                  >
                    <Icon name="sparkles" />
                    <span>Reasoning</span>
                  </button>
                ) : null}
                {rawDebugAvailable ? (
                  <button
                    className={`${styles.chatTakeawaysToggle} ${rawDebugOpen ? styles.chatTakeawaysToggleActive : ""}`}
                    type="button"
                    aria-label="Raw debugger"
                    aria-pressed={rawDebugOpen}
                    title="Development inspector: request, response headers, SSE frames, and trace events"
                    onClick={() => setRawDebugOpen((current) => !current)}
                  >
                    <Icon name="terminal" />
                  </button>
                ) : null}
                {swarmSnapshot.runId || swarmEnabled ? (
                  <button
                    className={`${styles.chatTakeawaysToggle} ${swarmPanelOpen ? styles.chatTakeawaysToggleActive : ""}`}
                    type="button"
                    aria-label="Swarm progress"
                    aria-pressed={swarmPanelOpen}
                    title={swarmPanelOpen ? "Hide swarm" : "Show swarm"}
                    onClick={() => {
                      setSwarmPanelOpen((open) => {
                        if (!open) {
                          setTakeawaysOpen(false);
                          setReasoningPanelOpen(false);
                        }
                        return !open;
                      });
                    }}
                  >
                    <Icon name="agents" />
                  </button>
                ) : null}
                {!takeawaysOpen && !reasoningPanelOpen && !swarmPanelOpen ? (
                  <button
                    className={styles.chatTakeawaysToggle}
                    type="button"
                    aria-label={`Expand key insights${keyInsights.length > 0 ? `, ${keyInsights.length} available` : ""}`}
                    aria-pressed={false}
                    aria-controls="analysis-takeaways"
                    onClick={() => {
                      setSwarmPanelOpen(false);
                      setReasoningPanelOpen(false);
                      setTakeawaysOpen(true);
                    }}
                  >
                    <Icon name="sidebarRight" />
                  </button>
                ) : null}
              </div>
            </header>
            {conversationSkelActive ? (
              <div
                ref={conversationSkelHostRef}
                className={[
                  styles.tSkel,
                  conversationSkelRevealed ? styles.isRevealed : "",
                  conversationSkelResetting ? styles.isResetting : "",
                ].filter(Boolean).join(" ")}
                role={conversationSkelRevealed ? undefined : "status"}
                aria-label={conversationSkelRevealed ? undefined : "Loading conversation"}
                aria-busy={conversationSkelPhase === "loading"}
                data-state={conversationSkelPhase}
              >
                <div
                  className={[
                    styles.tSkelSkeleton,
                    conversationSkelPhase === "loading" ? styles.isPulsing : "",
                  ].filter(Boolean).join(" ")}
                >
                  <div className={styles.tSkelTurn}>
                    <div className={styles.tSkelUser} />
                    <div className={styles.tSkelTrail} />
                    <div className={styles.tSkelAnswer}>
                      <span className={styles.tSkelAnswerLine} />
                      <span className={styles.tSkelAnswerLine} />
                      <span className={styles.tSkelAnswerLine} data-width="short" />
                    </div>
                  </div>
                  <div className={styles.tSkelTurn}>
                    <div className={styles.tSkelUser} data-width="mid" />
                    <div className={styles.tSkelTrail} />
                    <div className={styles.tSkelAnswer}>
                      <span className={styles.tSkelAnswerLine} />
                      <span className={styles.tSkelAnswerLine} data-width="short" />
                    </div>
                  </div>
                </div>
                <div
                  className={styles.tSkelContent}
                  aria-live={conversationSkelPhase === "revealing" ? "polite" : undefined}
                  ref={conversationSkelPhase === "revealing" ? chatMessagesRef : undefined}
                >
                  {conversationSkelPhase === "revealing" ? (
                    <>
                      {renderChatTurns()}
                      <div className={styles.chatScrollSpacer} ref={chatSpacerRef} aria-hidden="true" />
                    </>
                  ) : null}
                </div>
              </div>
            ) : conversationHistoryStatus.kind === "error" && chatMessages.length === 0 && activeConversationId ? (
              <div className={styles.chatOpeningState} role="alert">
                <p>{conversationHistoryStatus.message}</p>
                <button type="button" onClick={() => void openSavedConversation(activeConversationId)}>
                  Try again
                </button>
              </div>
            ) : chatMessages.length > 0 ? (
              <div className={styles.chatMessages} aria-live="polite" ref={chatMessagesRef}>
                {renderChatTurns()}
                <div className={styles.chatScrollSpacer} ref={chatSpacerRef} aria-hidden="true" />
              </div>
            ) : (
              <div className={styles.chatEmptyGrow} aria-hidden="true" />
            )}

            <motion.div
              className={`${styles.chatComposerStack} ${showHeroComposer ? styles.chatComposerStackHero : ""} ${chatComposerHero ? styles.chatComposerStackEmpty : ""} ${chatClarification ? styles.chatComposerStackConnected : ""}`}
            >
              <AnimatePresence initial={false}>
                {chatComposerHero ? (
                  <motion.div
                    key={`chat-hero:${activeChatRuntime}:${specialistAgentId}`}
                    className={styles.chatHeroIntro}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.32,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    <h2 className={styles.chatHeroTitle}>
                      {activeChatRuntime === "xero_mcp"
                        ? "Ask Xero anything"
                        : activeChatRuntime === "codex"
                          ? "Ask about your business"
                        : isCustomerAgent
                          ? activeSpecialistAgent.ui.emptyStateTitle
                          : "Ask me anything"}
                    </h2>
                    {activeChatRuntime === "codex" ? (
                      <>
                        <div className={styles.codexPromptMenu} ref={codexPromptMenuRef}>
                          <button
                            ref={codexPromptTriggerRef}
                            className={styles.codexPromptMenuTrigger}
                            type="button"
                            aria-haspopup="menu"
                            aria-expanded={codexPromptsOpen}
                            aria-controls={codexPromptMenuId}
                            onClick={() => setCodexPromptsOpen((current) => !current)}
                          >
                            <span>Suggested investigations</span>
                            <Icon
                              className={`${styles.codexPromptMenuChevron} ${codexPromptsOpen ? styles.codexPromptMenuChevronOpen : ""}`}
                              name="chevronDown"
                            />
                          </button>
                          <AnimatePresence>
                            {codexPromptsOpen ? (
                              <motion.div
                                id={codexPromptMenuId}
                                className={styles.codexPromptMenuPanel}
                                role="menu"
                                aria-label="Suggested investigations"
                                initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
                                transition={{
                                  duration: reduceMotion ? 0 : 0.4,
                                  ease: [0.04, 0.62, 0.23, 0.98],
                                }}
                              >
                                <div className={styles.codexPromptMenuList}>
                                  {codexStarterPrompts.map((prompt) => (
                                    <button
                                      key={prompt}
                                      className={styles.codexPromptMenuItem}
                                      type="button"
                                      role="menuitem"
                                      data-codex-starter="true"
                                      onClick={() => {
                                        setCodexPromptsOpen(false);
                                        void sendChatMessage(prompt);
                                      }}
                                    >
                                      {prompt}
                                    </button>
                                  ))}
                                </div>
                              </motion.div>
                            ) : null}
                          </AnimatePresence>
                        </div>
                      </>
                    ) : isCustomerAgent ? (
                      <>
                        <p className={styles.chatHeroBody}>{activeSpecialistAgent.ui.emptyStateBody}</p>
                        <div className={styles.chatStarterPrompts} aria-label="Verified customer questions">
                          {activeSpecialistAgent.starterPrompts.slice(0, 4).map((starter) => (
                            <button
                              key={starter.id}
                              className={styles.chatStarterPrompt}
                              type="button"
                              data-certified-query={starter.certifiedQueryName}
                              onClick={() => void sendChatMessage(starter.prompt)}
                            >
                              <span>{starter.prompt}</span>
                              <small><span aria-hidden="true">✓</span> Verified</small>
                            </button>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </motion.div>
                ) : null}
              </AnimatePresence>
              <AnimatePresence initial={false}>
                {chatClarification ? (
                  <motion.div
                    key="chat-clarify"
                    className={styles.chatClarify}
                    role="region"
                    aria-label="Clarification needed"
                    initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: 6 }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.28,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    <h3 className={styles.chatClarifyQuestion}>{chatClarification.question}</h3>
                    <div className={styles.chatClarifyOptions} role="group" aria-label="Suggested answers">
                      {chatClarification.options.map((option) => (
                        <button
                          className={styles.chatClarifyOption}
                          key={option}
                          type="button"
                          onClick={() => answerClarification(option)}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                    <div className={styles.chatClarifyManual}>
                      <input
                        className={styles.chatClarifyInput}
                        type="text"
                        value={clarifyDraft}
                        placeholder="Or type your own answer"
                        aria-label="Type your own clarification answer"
                        onChange={(event) => setClarifyDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            answerClarification(clarifyDraft);
                          }
                        }}
                      />
                      <button
                        className={styles.chatClarifySend}
                        type="button"
                        aria-label="Send clarification"
                        disabled={!clarifyDraft.trim()}
                        onClick={() => answerClarification(clarifyDraft)}
                      >
                        <Icon name="arrowUp" />
                      </button>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {!chatComposerHero ? (
                <button
                  className={`${styles.connectMobilePill} ${mobileConnectOpen ? styles.connectMobilePillOpen : ""}`}
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={mobileConnectOpen}
                  onClick={() => {
                    if (mobileConnectOpen) closeMobileConnect();
                    else openMobileConnect();
                  }}
                >
                  <span>Connect Mobile</span>
                  <span className={styles.connectMobileLearnChevron} aria-hidden="true">
                    <svg viewBox="0 0 16 16" fill="none">
                      <path
                        className={`${styles.connectMobileLearnArm} ${styles.connectMobileLearnArmTop}`}
                        d="M6 4L10 8"
                      />
                      <path
                        className={`${styles.connectMobileLearnArm} ${styles.connectMobileLearnArmBot}`}
                        d="M10 8L6 12"
                      />
                    </svg>
                  </span>
                </button>
              ) : null}

            <motion.form
              ref={chatComposerRef}
              className={`${styles.chatComposer} ${styles.chatComposerBar} ${showHeroComposer ? styles.chatComposerHero : ""} ${composerMultiline ? styles.chatComposerMultiline : ""}`}
              initial={false}
              animate={{
                borderRadius: composerMultiline ? 20 : 999,
                paddingTop: showHeroComposer ? 12 : 6,
                paddingBottom: showHeroComposer ? 12 : 6,
                paddingLeft: showHeroComposer ? 10 : 6,
                paddingRight: showHeroComposer ? 10 : 6,
              }}
              transition={{
                duration: reduceMotion ? 0 : 0.28,
                ease: [0.22, 1, 0.36, 1],
              }}
              onSubmit={(event) => {
                event.preventDefault();
                if (voice.status === "connecting" || voice.status === "live") return;
                if (dictation.status === "recording") {
                  void dictation.stopAndSend(chatDraft, setChatDraft, (text) => {
                    void sendChatMessage(text);
                  });
                  return;
                }
                if (dictation.status === "transcribing") return;
                void sendChatMessage();
              }}
            >
              <button
                className={styles.chatComposerPlus}
                type="button"
                aria-label="Attachments coming soon"
                disabled
              >
                <Icon name="plus" />
              </button>
              <div className={styles.chatComposerInputRow}>
                {voice.status === "connecting" || voice.status === "live" ? (
                  <div className={styles.voiceInputRow}>
                    <DictationWaveform
                      volume={voice.volume}
                      processing={voice.status === "connecting" || voice.activity === "thinking"}
                      label={voice.status === "connecting" ? "Connecting voice" : "Voice conversation"}
                    />
                    <span className={styles.voiceStatusText} aria-live="polite">
                      {voice.status === "connecting"
                        ? "Connecting…"
                        : voice.activity === "thinking"
                          ? (voice.statusLine || "Working on it…")
                          : voice.activity === "responding"
                            ? "Speaking"
                            : "Listening"}
                    </span>
                  </div>
                ) : dictation.status === "recording" || dictation.status === "transcribing" ? (
                  <DictationWaveform
                    volume={dictation.volume}
                    processing={dictation.status === "transcribing"}
                    label={dictation.status === "transcribing" ? "Finishing dictation" : "Listening"}
                  />
                ) : (
                  <textarea
                    ref={chatTextareaRef}
                    aria-label={
                      swarmEnabled
                        ? "Ask a harder question for Swarm"
                        : activeChatRuntime === "xero_mcp"
                        ? "Ask Xero anything"
                        : activeChatRuntime === "codex"
                          ? "Ask Codex about your business"
                        : isCustomerAgent
                          ? "Ask the Customer Agent"
                          : "Ask me anything"
                    }
                    placeholder={
                      swarmEnabled
                        ? chatMessages.length > 0
                          ? "Ask a harder follow-up. Swarm will split the work…"
                          : "Ask a bigger question. Swarm will split the work across specialists…"
                      : activeChatRuntime === "codex"
                        ? chatMessages.length > 0
                          ? "Ask Codex a follow-up…"
                          : "Ask Codex anything about your connected data…"
                      : isCustomerAgent
                        ? chatMessages.length > 0
                          ? "Ask a follow-up about your customers…"
                          : `${activeSpecialistAgent.ui.composerPlaceholder}…`
                        : chatMessages.length > 0
                          ? "Send follow-up"
                        : activeChatRuntime === "xero_mcp"
                          ? "Ask anything about Xero…"
                          : "Ask anything about your business…"
                    }
                    rows={1}
                    value={chatDraft}
                    onFocus={() => {
                      if (chatMessages.length === 0) {
                        setComposerExpanded(true);
                      }
                    }}
                    onChange={(event) => {
                      if (dictation.error) dictation.clearError();
                      setChatDraft(event.target.value);
                      window.requestAnimationFrame(() => resizeComposerTextarea());
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendChatMessage();
                      }
                    }}
                  />
                )}
              </div>
              <div className={styles.chatComposerTrailing}>
                {(voice.status === "connecting" || voice.status === "live") ? (
                  <button
                    className={`${styles.composerIconButton} ${styles.composerIconButtonActive} ${styles.voiceButtonLive}`}
                    type="button"
                    aria-label="End voice conversation"
                    title="End voice conversation"
                    onClick={() => voice.stop()}
                  >
                    <Icon name="voice" />
                  </button>
                ) : null}
                {voice.status !== "connecting" && voice.status !== "live" && dictation.status === "idle" ? (
                  <button
                    className={`${styles.swarmToggle} ${swarmEnabled ? styles.swarmToggleActive : ""}`}
                    type="button"
                    aria-pressed={swarmEnabled}
                    aria-label="Swarm"
                    title="Split a hard question across specialists, then combine their findings"
                    onClick={() => {
                      if (activeChatRuntime !== "codex") {
                        startCodexChat();
                        setSwarmMode(true);
                        return;
                      }
                      setSwarmMode((current) => !current);
                    }}
                  >
                    <Icon name="agents" />
                    <span className={styles.swarmToggleLabel}>Swarm</span>
                  </button>
                ) : null}
                {voice.status !== "connecting" && voice.status !== "live" && dictation.status === "idle" && (
                  activeChatRuntime === "codex" ? (
                    <ModelRunControls
                      value={agentPreferences}
                      onChange={setAgentPreferences}
                      allowedModelIds={CODEX_MODEL_IDS}
                      allowedReasoningEfforts={CODEX_REASONING_EFFORTS}
                      solPlannerEnabled={codexSolPlannerEnabled}
                      onSolPlannerChange={setCodexSolPlannerEnabled}
                      proModeEnabled={codexProModeEnabled}
                      onProModeChange={setCodexProModeEnabled}
                    />
                  ) : activeChatRuntime === "anthropic" ? (
                    <span className={styles.chatRuntimeIndicator}>Claude Opus 5</span>
                  ) : activeChatRuntime === "cubecore" ? (
                    <span className={styles.chatRuntimeIndicator}>Cubecore</span>
                  ) : activeChatRuntime === "xero_mcp" ? (
                    <span className={styles.chatRuntimeIndicator}>Xero MCP</span>
                  ) : (
                    <ModelRunControls
                      value={agentPreferences}
                      onChange={setAgentPreferences}
                      allowedModelIds={V3_MODEL_IDS}
                    />
                  )
                )}
                {voice.status !== "connecting" && voice.status !== "live" && dictation.status === "idle" ? (
                  <button
                    className={styles.composerIconButton}
                    type="button"
                    aria-label="Talk to Albert"
                    title="Talk to Albert"
                    onClick={() => {
                      if (chatMessages.length === 0) setComposerExpanded(true);
                      if (dictation.error) dictation.clearError();
                      voice.clearError();
                      void voice.start();
                    }}
                  >
                    <Icon name="voice" />
                  </button>
                ) : null}
                {voice.status === "connecting" || voice.status === "live" ? null : dictation.status === "idle" ? (
                  <button
                    className={styles.composerIconButton}
                    type="button"
                    aria-label="Dictate"
                    onClick={() => {
                      if (chatMessages.length === 0) setComposerExpanded(true);
                      void dictation.start();
                    }}
                  >
                    <Icon name="microphone" />
                  </button>
                ) : (
                  <button
                    className={`${styles.composerIconButton} ${styles.composerIconButtonActive}`}
                    type="button"
                    aria-label="Stop dictation"
                    disabled={dictation.status === "transcribing"}
                    onClick={() => {
                      void dictation.stop(chatDraft, (next) => {
                        setChatDraft(next);
                        window.requestAnimationFrame(() => resizeComposerTextarea());
                      });
                    }}
                  >
                    <Icon name="stop" />
                  </button>
                )}
                {voice.status === "connecting" || voice.status === "live" ? null : dictation.status === "recording" || dictation.status === "transcribing" ? (
                  <motion.button
                    className={styles.chatSendButton}
                    type="button"
                    layout={!reduceMotion ? "position" : false}
                    transition={{
                      layout: {
                        duration: reduceMotion ? 0 : 0.42,
                        ease: [0.22, 1, 0.36, 1],
                      },
                    }}
                    aria-label="Stop and send"
                    disabled={dictation.status === "transcribing"}
                    onClick={() => {
                      void dictation.stopAndSend(
                        chatDraft,
                        (next) => {
                          setChatDraft(next);
                          window.requestAnimationFrame(() => resizeComposerTextarea());
                        },
                        (text) => {
                          void sendChatMessage(text);
                        },
                      );
                    }}
                  >
                    <Icon name="arrowUp" />
                  </motion.button>
                ) : chatBusy ? (
                  <motion.button
                    className={`${styles.chatSendButton} ${styles.chatStopButton}`}
                    type="button"
                    layout={!reduceMotion ? "position" : false}
                    transition={{
                      layout: {
                        duration: reduceMotion ? 0 : 0.42,
                        ease: [0.22, 1, 0.36, 1],
                      },
                    }}
                    aria-label="Stop response"
                    onClick={stopChatResponse}
                  >
                    <Icon name="stop" />
                  </motion.button>
                ) : (
                  <motion.button
                    className={styles.chatSendButton}
                    type="submit"
                    layout={!reduceMotion ? "position" : false}
                    transition={{
                      layout: {
                        duration: reduceMotion ? 0 : 0.42,
                        ease: [0.22, 1, 0.36, 1],
                      },
                    }}
                    aria-label="Send message"
                    disabled={!chatDraft.trim()}
                  >
                    <Icon name="arrowUp" />
                  </motion.button>
                )}
              </div>
            </motion.form>
            {dictation.error ? (
              <p className={styles.dictationError} role="alert">
                {dictation.error}
              </p>
            ) : voice.error ? (
              <p className={styles.dictationError} role="alert">
                {voice.error}
              </p>
            ) : null}
            {showRecommendedHome ? (
              <RecommendedAnalysis
                onAsk={(question) => void sendChatMessage(question)}
                reduceMotion={Boolean(reduceMotion)}
              />
            ) : null}
            </motion.div>

            <motion.div
              className={styles.chatEmptyGrow}
              aria-hidden="true"
              initial={false}
              // Only for empty New Analysis (hero). Growing this during skeleton
              // load put the composer mid-page, then lowered it when messages arrived.
              animate={{ flexGrow: chatComposerHero ? 1 : 0 }}
              transition={{
                duration: reduceMotion ? 0 : 0.5,
                ease: [0.22, 1, 0.36, 1],
              }}
            />
          </div>

          <aside
            id="analysis-takeaways"
            className={`${styles.takeawaysPanel} ${sidePanelOpen ? styles.takeawaysPanelOpen : ""}`}
            aria-label={swarmPanelOpen ? "Swarm" : reasoningPanelOpen ? "Reasoning" : "Key insights"}
            aria-hidden={!sidePanelOpen}
            inert={!sidePanelOpen || undefined}
          >
            {swarmPanelOpen ? (
              <SwarmPanel
                onClose={() => setSwarmPanelOpen(false)}
                width={swarmPanelWidth}
                onWidthChange={setSwarmPanelWidth}
                onResizeActiveChange={setSwarmPanelResizing}
                onWidenPastDefault={() => setCollapsed(true)}
              />
            ) : reasoningPanelOpen ? (
              <div className={styles.takeawaysPanelInner}>
                <div className={styles.takeawaysHeader}>
                  <h2>Reasoning</h2>
                  <button
                    className={styles.takeawaysClose}
                    type="button"
                    aria-label="Collapse reasoning"
                    onClick={() => setReasoningPanelOpen(false)}
                  >
                    <Icon name="chevron" />
                  </button>
                </div>
                <div className={`${styles.takeawaysBody} ${styles.reasoningPanelBody}`}>
                  <div className={styles.reasoningPanelIntro}>
                    <span
                      className={`${styles.reasoningPanelStatusDot} ${reasoningTurns.some((turn) => turn.streaming) ? styles.reasoningPanelStatusDotLive : ""}`}
                      aria-hidden="true"
                    />
                    <p>
                      OpenAI’s live reasoning summary. Private chain-of-thought stays hidden.
                    </p>
                  </div>
                  {reasoningTurns.length > 0 ? (
                    <div className={styles.reasoningTurnList}>
                      {reasoningTurns.map((turn, index) => (
                        <article className={styles.reasoningTurn} key={turn.id}>
                          <div className={styles.reasoningTurnHeader}>
                            <span>{turn.streaming ? "Live" : `Turn ${index + 1}`}</span>
                            {turn.streaming ? <span className={styles.reasoningStreamingLabel}>Streaming</span> : null}
                          </div>
                          {turn.question ? <h3>{turn.question}</h3> : null}
                          {turn.summary ? (
                            <p aria-live={turn.streaming ? "polite" : undefined}>{turn.summary}</p>
                          ) : (
                            <p className={styles.reasoningWaiting} role="status">
                              Waiting for OpenAI’s first reasoning summary…
                            </p>
                          )}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.takeawaysEmptyState}>
                      <strong>No reasoning summary yet</strong>
                      <p>Send a Codex question and its reasoning summary will stream here as OpenAI provides it.</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className={styles.takeawaysPanelInner}>
                <div className={styles.takeawaysHeader}>
                  <h2>Key Insights</h2>
                  <button
                    className={styles.takeawaysClose}
                    type="button"
                    aria-label="Collapse key insights"
                    onClick={() => setTakeawaysOpen(false)}
                  >
                    <Icon name="chevron" />
                  </button>
                </div>
                <div className={styles.takeawaysBody}>
                  <KeyInsightsPanel
                    insights={keyInsights}
                    streaming={keyInsightsStreaming}
                    activity={keyInsightActivity}
                  />
                </div>
              </div>
            )}
          </aside>

          </div>
        ) : activeItem === "Agents" ? (
          <AgentsWorkspace
            onStartSalesSwarm={startSalesDeepSwarm}
            salesSwarmBusy={swarmSnapshot.active}
          />
        ) : activeItem === "Proactive" ? (
          <ProactiveWorkspace
            onOpenConversation={(conversationId) => void openSavedConversation(conversationId)}
            onProactiveConversationIds={(ids) => setProactiveConversationIds(new Set(ids))}
          />
        ) : activeItem === "Dashboard" ? (
          <DashboardWorkspace onOpenSource={(conversationId) => void openSavedConversation(conversationId)} />
        ) : activeItem === "My Data" ? (
          <MyDataWorkspace />
        ) : activeItem === "Test chart" ? (
          <TestChartWorkspace
            appearance={theme === "dark" || theme === "green" ? "dark" : theme === "system" ? "system" : "light"}
          />
        ) : activeItem === "New test" ? (
          <NewTestWorkspace />
        ) : activeItem === "Logs" && canViewQueryLogs ? (
          <QueryLogsWorkspace onOpenConversation={(conversationId) => void openSavedConversation(conversationId)} />
        ) : activeItem === "Connections" ? (
          <ConnectionsWorkspace
            data={connectionsData}
            status={connectionsStatus}
            notice={oauthNotice}
            canManage={canManageConnections}
            onConnect={connectProvider}
            onSelectOAuthAccount={selectOAuthAccount}
            onDisconnect={disconnectConnection}
            onIngestionStarted={() => void loadConnections({ silent: true })}
            onRetry={() => void loadConnections()}
          />
        ) : activeItem === "Admin" && isInternalOperator ? (
          <AdminWorkspace />
        ) : activeItem === "BusinessContext" ? (
          <BusinessContextWorkspace />
        ) : activeItem === "SemanticMemory" ? (
          <SemanticMemoryWorkspace />
        ) : activeItem === "Organization" ? (
          <OrganizationWorkspace
            onOrganisationChanged={() => window.location.reload()}
            onOrganisationRenamed={(name) => setAccountOrganisation((current) => ({ ...current, name }))}
          />
        ) : (
          <div className={styles.contentBody}>
            <p className={styles.contentEyebrow}>ACCESS UNAVAILABLE</p>
            <h2>This area is not available for your current role.</h2>
            <p className={styles.contentDescription}>Open Connections from the account menu, or start a new analysis from the sidebar.</p>
          </div>
        )}
      </section>

      {mobileConnectOpen ? (
        <div
          className={`${styles.mobileConnectBackdrop} ${mobileConnectClosing ? styles.mobileConnectBackdropClosing : ""}`}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeMobileConnect();
          }}
        >
          <div
            className={`${styles.mobileConnectDialog} ${mobileConnectClosing ? styles.mobileConnectDialogClosing : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-connect-title"
          >
            <button
              className={styles.mobileConnectClose}
              type="button"
              aria-label="Close connect mobile"
              onClick={closeMobileConnect}
            >
              <Icon name="close" />
            </button>

            <div className={styles.mobileConnectHeader}>
              <h2 id="mobile-connect-title">Natural language analytics</h2>
              <p className={styles.mobileConnectLead}>
                Get Albert on your phone. Enter your Australian mobile number.
              </p>
            </div>

            <form
              className={styles.mobileConnectForm}
              onSubmit={(event) => {
                event.preventDefault();
                // UI only for now: no connect action yet.
              }}
            >
              <div className={styles.mobileConnectGroup}>
                <div className={styles.mobileConnectField}>
                  <span className={styles.mobileConnectPrefix} aria-hidden="true">+61</span>
                  <input
                    ref={mobileNumberInputRef}
                    id="mobile-connect-number"
                    className={styles.mobileConnectInput}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel-national"
                    autoCorrect="off"
                    spellCheck={false}
                    lang="en-AU"
                    placeholder="412 345 678"
                    value={mobileNumber}
                    aria-label="Australian mobile number"
                    onChange={(event) => {
                      setMobileNumber(formatAuMobileDisplay(event.target.value));
                    }}
                  />
                </div>
              </div>

              <div className={styles.mobileConnectActions}>
                <button
                  className={styles.mobileConnectSubmit}
                  type="submit"
                  disabled={!isValidAuMobile(mobileNumber)}
                >
                  Connect
                </button>
                <button
                  className={styles.mobileConnectCancel}
                  type="button"
                  onClick={closeMobileConnect}
                >
                  Not now
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {rawDebugAvailable && rawDebugOpen ? (
        <RawDebugger
          turns={rawDebugTurns}
          onClose={() => setRawDebugOpen(false)}
          onClear={() => setRawDebugTurns([])}
        />
      ) : null}

      {editResendConfirm ? (
        <div
          className={`${styles.popupBackdrop} ${editResendConfirmClosing ? styles.popupBackdropClosing : ""}`}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeEditResendConfirm();
          }}
        >
          <div
            className={`${styles.albertPopup} ${styles.rewindConfirmPopup} ${editResendConfirmClosing ? styles.albertPopupClosing : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-resend-title"
            aria-describedby="edit-resend-copy"
          >
            <h2 id="edit-resend-title">Rerun this question?</h2>
            <p id="edit-resend-copy">
              Later messages in this chat will be removed.
            </p>
            <div className={styles.popupActions}>
              <button
                className={styles.popupSecondaryAction}
                type="button"
                onClick={closeEditResendConfirm}
                disabled={editResendBusy}
              >
                Cancel
              </button>
              <button
                ref={editResendConfirmButtonRef}
                className={styles.popupPrimaryAction}
                type="button"
                onClick={() => void confirmEditedMessageResend()}
                disabled={editResendBusy}
              >
                {editResendBusy ? "Rerunning…" : "Rerun"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

    </main>
  );
}
