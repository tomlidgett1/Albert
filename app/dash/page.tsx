"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type SVGProps } from "react";
import { AnimatePresence, animate, motion, useReducedMotion } from "framer-motion";
import { useRouter } from "next/navigation";
import {
  DEFAULT_AGENT_PREFERENCES,
  normalizeAgentPreferences,
  type AgentRunPreferences,
  type TraceEvent,
} from "@/packages/shared/src";
import { createClient } from "@/utils/supabase/client";
import AnalyticalTrace from "./components/AnalyticalTrace";
import AdminWorkspace from "./components/AdminWorkspace";
import ConnectionsWorkspace, {
  emptyConnectionsWorkspace,
  type ConnectionsWorkspaceData,
  type ConnectionProviderId,
  type MatchDecision,
} from "./components/ConnectionsWorkspace";
import { ModelRunControls } from "./components/ModelRunControls";
import OrganizationWorkspace from "./components/OrganizationWorkspace";
import TenantDeletionWorkspace, {
  parseTenantDeletionReceipt,
  type TenantDeletionReceipt,
} from "./components/TenantDeletionWorkspace";
import styles from "./dash.module.css";

type IconName =
  | "search"
  | "panel"
  | "monitor"
  | "sun"
  | "moon"
  | "chat"
  | "connections"
  | "logs"
  | "organization"
  | "logout"
  | "chevron"
  | "plus"
  | "arrowUp"
  | "close";

type NavItem = {
  label: string;
  icon: IconName;
};

const navItems: NavItem[] = [
  { label: "Chat", icon: "chat" },
  { label: "Connections", icon: "connections" },
];

type Theme = "system" | "light" | "dark";

const themeOptions: Array<{ value: Theme; label: string; icon: IconName }> = [
  { value: "system", label: "System theme", icon: "monitor" },
  { value: "light", label: "Light theme", icon: "sun" },
  { value: "dark", label: "Dark theme", icon: "moon" },
];

const themeStorageKey = "albert-theme";

const themeListeners = new Set<() => void>();
let themeSnapshot: Theme = "system";

function isTheme(value: string | null): value is Theme {
  return value === "system" || value === "light" || value === "dark";
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
    case "chat":
      return <svg {...shared}><path d="M20.2 11.2c0 4.5-3.7 8.1-8.3 8.1a8.8 8.8 0 0 1-3.2-.6l-4.7 1.2 1.2-4.3a7.8 7.8 0 0 1-1.5-4.4c0-4.5 3.7-8.1 8.2-8.1s8.3 3.6 8.3 8.1Z" /></svg>;
    case "connections":
      return <svg {...shared}><path d="M9.2 14.8 7.6 16.4a3.2 3.2 0 0 1-4.5-4.5l3.3-3.3a3.2 3.2 0 0 1 4.5 0" /><path d="m14.8 9.2 1.6-1.6a3.2 3.2 0 0 1 4.5 4.5l-3.3 3.3a3.2 3.2 0 0 1-4.5 0" /><path d="m8.5 15.5 7-7" /></svg>;
    case "logs":
      return <svg {...shared}><path d="m5 7 2-2h10l2 2" /><path d="m5 12 2-2h10l2 2" /><path d="m5 17 2-2h10l2 2" /></svg>;
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
    default:
      return null;
  }
}

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  isStreaming?: boolean;
  events?: TraceEvent[];
  runtime?: "fixture" | "openai";
  conversationId?: string;
  turnId?: string;
  suppressEnter?: boolean;
  animateReveal?: boolean;
};

type ChatClarification = {
  question: string;
  options: [string, string];
};

type ConversationSummary = Readonly<{
  conversationId: string;
  title: string;
  status: string;
  updatedAt: string;
  lastMessage: string;
}>;

type OAuthNotice = Readonly<{
  kind: "success" | "info" | "error";
  message: string;
}>;

const oauthProviderLabels: Readonly<Record<ConnectionProviderId, string>> = Object.freeze({
  lightspeed: "Lightspeed",
  xero: "Xero",
  deputy: "Deputy",
});

function oauthNoticeFrom(searchParams: URLSearchParams): OAuthNotice | null {
  const status = searchParams.get("oauth");
  if (!status) return null;
  const rawProvider = searchParams.get("provider");
  const provider = rawProvider === "lightspeed" || rawProvider === "xero" || rawProvider === "deputy"
    ? oauthProviderLabels[rawProvider]
    : "This source";

  switch (status) {
    case "connected":
      return { kind: "success", message: `${provider} is connected. The recent-first sync has started.` };
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
    default:
      return { kind: "error", message: `${provider} authorization could not be completed. Try connecting again.` };
  }
}

const traceEventTypes = new Set([
  "progress",
  "narrative",
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
    const lastMessage = lastTurn && typeof (lastTurn as Record<string, unknown>).user_message === "string"
      ? String((lastTurn as Record<string, unknown>).user_message)
      : "New conversation";
    summaries.push({
      conversationId: candidate.conversation_id,
      title: candidate.title?.toString().trim() || lastMessage,
      status: candidate.status,
      updatedAt: candidate.updated_at,
      lastMessage,
    });
  }
  return summaries;
}

function conversationTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Saved conversation";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
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
  const [oauthNotice, setOAuthNotice] = useState<OAuthNotice | null>(null);
  const [connectionsData, setConnectionsData] = useState<ConnectionsWorkspaceData>(emptyConnectionsWorkspace);
  const [connectionsStatus, setConnectionsStatus] = useState<{
    kind: "loading" | "error" | "ready";
    message?: string;
  }>({ kind: "loading" });
  const [tenantDeletionReceipt, setTenantDeletionReceipt] = useState<TenantDeletionReceipt | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [activeItem, setActiveItem] = useState("Chat");
  const theme = useSyncExternalStore(
    subscribeToTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>();
  const [agentPreferences, setAgentPreferences] = useState<AgentRunPreferences>(DEFAULT_AGENT_PREFERENCES);
  const [isChatResponding, setIsChatResponding] = useState(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [conversationSummaries, setConversationSummaries] = useState<readonly ConversationSummary[]>([]);
  const [conversationHistoryStatus, setConversationHistoryStatus] = useState<{
    kind: "idle" | "loading" | "ready" | "error";
    message?: string;
  }>({ kind: "idle" });
  const [chatClarification, setChatClarification] = useState<ChatClarification | null>(null);
  const [clarifyDraft, setClarifyDraft] = useState("");
  const [composerExpanded, setComposerExpanded] = useState(false);
  const reduceMotion = useReducedMotion();
  const accountAreaRef = useRef<HTMLDivElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const chatSpacerRef = useRef<HTMLDivElement>(null);
  const chatComposerRef = useRef<HTMLFormElement>(null);
  const lastPinnedUserMessageIdRef = useRef<number | null>(null);
  const composerOriginTopRef = useRef<number | null>(null);
  const chatPinAnimationsRef = useRef<Array<{ stop: () => void }>>([]);
  const chatPinTimerRef = useRef<number | undefined>(undefined);
  const composerExpandTimerRef = useRef<number | undefined>(undefined);
  const chatRequestAbortRef = useRef<AbortController | null>(null);
  const chatMessageSequenceRef = useRef(0);
  const visibleNavItems = useMemo<readonly NavItem[]>(
    () => tenantDeletionReceipt
      ? [{ label: "Deletion", icon: "organization" }]
      : isInternalOperator ? [...navItems, { label: "Admin", icon: "logs" }] : navItems,
    [isInternalOperator, tenantDeletionReceipt],
  );
  const filteredItems = useMemo(
    () => visibleNavItems.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
    [query, visibleNavItems],
  );
  const chatComposerHero = activeItem === "Chat" && chatMessages.length === 0;
  const chatComposerCompact = activeItem === "Chat" && !composerExpanded;
  const canManageConnections = accountOrganisation.role === "owner" || accountOrganisation.role === "manager";
  const accountInitial = accountEmail.trim().charAt(0).toUpperCase() || "P";
  const accountRoleLabel = accountOrganisation.role?.replaceAll("_", " ") ?? "Loading organisation";

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
    const url = new URL(window.location.href);
    const requestedView = url.searchParams.get("view");
    const nextOAuthNotice = oauthNoticeFrom(url.searchParams);
    if (url.searchParams.has("oauth") || url.searchParams.has("provider")) {
      url.searchParams.delete("oauth");
      url.searchParams.delete("provider");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (requestedView !== "Connections" && !nextOAuthNotice) return;
    const task = window.setTimeout(() => {
      if (requestedView === "Connections" || nextOAuthNotice) setActiveItem("Connections");
      setOAuthNotice(nextOAuthNotice);
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const loadConnections = useCallback(async () => {
    setConnectionsStatus({ kind: "loading" });
    try {
      const sessionResponse = await fetch("/api/session", { cache: "no-store" });
      const sessionPayload = await sessionResponse.json() as {
        error?: string;
        needsBootstrap?: boolean;
        internalOperator?: boolean;
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
      setConnectionsData(parsed);
      setConnectionsStatus({ kind: "ready" });
    } catch (error) {
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

  const connectProvider = (providerId: ConnectionProviderId) => {
    window.location.assign(`/api/oauth/${providerId}/start`);
  };

  const answerConnectionQuestion = async (questionId: string, optionId: string) => {
    const response = await fetch("/api/connections/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "answer_blocking_question", questionId, optionId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      setConnectionsStatus({ kind: "error", message: payload?.error || "The answer was not saved." });
      return false;
    }
    await loadConnections();
    return true;
  };

  const decideConnectionMatch = async (taskId: string, decision: MatchDecision) => {
    const response = await fetch("/api/connections/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "identity_decision", taskId, decision }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      setConnectionsStatus({ kind: "error", message: payload?.error || "The match decision was not saved." });
      return false;
    }
    await loadConnections();
    for (const delay of [1_500, 4_000, 10_000]) {
      window.setTimeout(() => void loadConnections(), delay);
    }
    return true;
  };

  const selectOAuthAccount = async (oauthSessionId: string, externalAccountId: string) => {
    setConnectionsStatus({ kind: "loading", message: "Finishing the connection and starting the first sync." });
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
      setConversationSummaries(parsed);
      setConversationHistoryStatus({ kind: "ready" });
    } catch (error) {
      setConversationSummaries([]);
      setConversationHistoryStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Conversation history could not be loaded.",
      });
    }
  }, []);

  const openSavedConversation = async (conversationId: string) => {
    if (isChatResponding) return;
    setConversationHistoryStatus({ kind: "loading", message: "Opening conversation…" });
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as {
        history?: unknown;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(payload?.error || "The conversation could not be opened.");
      if (!payload?.history || typeof payload.history !== "object" || Array.isArray(payload.history)) {
        throw new Error("The conversation returned an invalid response.");
      }
      const history = payload.history as Record<string, unknown>;
      if (history.conversation_id !== conversationId || !Array.isArray(history.turns)) {
        throw new Error("The conversation returned invalid state.");
      }

      const restored: ChatMessage[] = [];
      let messageId = 0;
      let restoredPreferences = agentPreferences;
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
        restored.push({
          id: messageId,
          role: "assistant",
          text: "",
          events,
          isStreaming: turn.status === "running",
          runtime: "openai",
          conversationId,
          turnId: turn.turn_id,
          suppressEnter: true,
        });
        restoredPreferences = normalizeAgentPreferences(turn.runtime_profile);
      }
      if (restored.length === 0) throw new Error("This conversation does not contain any persisted turns yet.");

      chatRequestAbortRef.current?.abort();
      chatRequestAbortRef.current = null;
      chatMessageSequenceRef.current = messageId;
      setActiveConversationId(conversationId);
      setAgentPreferences(restoredPreferences);
      setChatMessages(restored);
      setComposerExpanded(true);
      setChatHistoryOpen(false);
      setConversationHistoryStatus({ kind: "ready" });
    } catch (error) {
      setConversationHistoryStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "The conversation could not be opened.",
      });
    }
  };

  useEffect(() => () => {
    chatRequestAbortRef.current?.abort();
    chatPinAnimationsRef.current.forEach((animation) => animation.stop());
    if (chatPinTimerRef.current !== undefined) window.clearTimeout(chatPinTimerRef.current);
    if (composerExpandTimerRef.current !== undefined) window.clearTimeout(composerExpandTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    const container = chatMessagesRef.current;
    const spacer = chatSpacerRef.current;
    if (!container || !spacer || chatMessages.length === 0) {
      if (spacer) spacer.style.minHeight = "0px";
      lastPinnedUserMessageIdRef.current = null;
      composerOriginTopRef.current = null;
      return;
    }

    const topGap = 8;
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
      while (sibling && sibling !== spacer) {
        contentAfter += sibling.offsetHeight + gap;
        sibling = sibling.nextElementSibling as HTMLElement | null;
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

    const pinWithFlip = (userEl: HTMLElement, messageId: number) => {
      const firstRect = userEl.getBoundingClientRect();
      spacer.style.minHeight = `${computeSpacerHeight(userEl)}px`;
      const userTop = userEl.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTop = Math.max(0, userTop - topGap);
      const lastRect = userEl.getBoundingClientRect();
      const dy = firstRect.top - lastRect.top;
      lastPinnedUserMessageIdRef.current = messageId;

      if (reduceMotion || Math.abs(dy) < 1) {
        resetFlyingStyles(userEl);
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
        },
      });
      chatPinAnimationsRef.current.push(flipAnimation);
    };

    const pinFirstMessage = (userEl: HTMLElement, messageId: number, originTop: number) => {
      const assistantEl = userEl.nextElementSibling as HTMLElement | null;
      const startRect = userEl.getBoundingClientRect();

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

      const destinationTop = container.getBoundingClientRect().top + topGap;

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
          if (assistantEl && assistantEl !== spacer) {
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
          }
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

    const alreadyPinned = lastPinnedUserMessageIdRef.current === lastUserMessage.id;
    if (alreadyPinned) {
      updateSpacerOnly();
    } else {
      clearPinAnimations();
      const originTop = composerOriginTopRef.current;
      if (originTop !== null && !reduceMotion) {
        pinFirstMessage(userEl, lastUserMessage.id, originTop);
      } else if (originTop !== null && reduceMotion) {
        spacer.style.minHeight = `${computeSpacerHeight(userEl)}px`;
        container.scrollTop = 0;
        lastPinnedUserMessageIdRef.current = lastUserMessage.id;
        composerOriginTopRef.current = null;
      } else {
        pinWithFlip(userEl, lastUserMessage.id);
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

    const closeMenuOnOutsidePress = (event: PointerEvent) => {
      if (!accountAreaRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };

    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountOpen(false);
    };

    document.addEventListener("pointerdown", closeMenuOnOutsidePress);
    document.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenuOnOutsidePress);
      document.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [accountOpen]);

  const sendChatMessage = async (
    suggestedText?: string,
    confirmedOption?: Readonly<{ offeredTurnId: string; optionId: string }>,
  ) => {
    const text = (suggestedText ?? chatDraft).trim();
    if (!text || isChatResponding) return;

    chatMessageSequenceRef.current += 2;
    const userId = chatMessageSequenceRef.current - 1;
    const assistantId = chatMessageSequenceRef.current;
    const firstFlight = chatMessages.length === 0;
    if (firstFlight && chatComposerRef.current) {
      composerOriginTopRef.current = chatComposerRef.current.getBoundingClientRect().top;
    } else {
      composerOriginTopRef.current = null;
    }

    setChatMessages((messages) => [
      ...messages,
      { id: userId, role: "user", text, suppressEnter: firstFlight },
      { id: assistantId, role: "assistant", text: "", isStreaming: true, events: [], suppressEnter: firstFlight },
    ]);
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
    setChatHistoryOpen(false);
    setChatClarification(null);
    setClarifyDraft("");
    setIsChatResponding(true);

    chatRequestAbortRef.current?.abort();
    const controller = new AbortController();
    chatRequestAbortRef.current = controller;
    const receivedEvents: TraceEvent[] = [];

    const updateAssistant = (patch: Partial<ChatMessage>) => {
      setChatMessages((messages) => messages.map((message) => (
        message.id === assistantId ? { ...message, ...patch } : message
      )));
    };

    try {
      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          preferences: agentPreferences,
          conversationId: activeConversationId,
          confirmedOption,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "Albert could not start this analysis.");
      }

      const runtime = response.headers.get("X-Albert-Runtime") === "fixture" ? "fixture" : "openai";
      const responseConversationId = response.headers.get("X-Albert-Conversation-Id");
      const responseTurnId = response.headers.get("X-Albert-Turn-Id");
      if (runtime === "openai" && (
        !responseConversationId || !ulidPattern.test(responseConversationId)
        || !responseTurnId || !ulidPattern.test(responseTurnId)
      )) {
        await response.body?.cancel("missing_immutable_turn_identifiers");
        throw new Error("The governed stream did not include its immutable turn identifiers.");
      }
      if (responseConversationId && ulidPattern.test(responseConversationId)) {
        setActiveConversationId(responseConversationId);
      }
      updateAssistant({
        runtime,
        ...(responseConversationId && responseTurnId ? {
          conversationId: responseConversationId,
          turnId: responseTurnId,
        } : {}),
      });

      if (!response.body) throw new Error("The conversation stream was unavailable.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const acceptBlock = (block: string) => {
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) return;

        const event = parseTraceEvent(JSON.parse(data));
        if (!event || receivedEvents.some((item) => item.id === event.id)) return;
        receivedEvents.push(event);
        receivedEvents.sort((first, second) => first.sequence - second.sequence);
        updateAssistant({ events: [...receivedEvents] });
      };

      while (true) {
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
      if (buffer.trim()) acceptBlock(buffer);
      if (receivedEvents.length === 0) throw new Error("Albert returned an empty analysis trace.");

      updateAssistant({ isStreaming: false, events: [...receivedEvents] });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Albert could not complete this analysis.";
      const errorEvent: TraceEvent = {
        id: `trace_error_${assistantId}`,
        sequence: receivedEvents.length + 1,
        type: "error",
        status: "error",
        occurredAt: new Date().toISOString(),
        message,
        recoverable: true,
      };
      updateAssistant({ isStreaming: false, events: [...receivedEvents, errorEvent] });
    } finally {
      if (chatRequestAbortRef.current === controller) chatRequestAbortRef.current = null;
      if (!controller.signal.aborted) setIsChatResponding(false);
    }
  };

  const answerClarification = (answer: string, offeredTurnId?: string, optionId?: string) => {
    const text = answer.trim();
    if (!text || isChatResponding) return;
    setChatClarification(null);
    setClarifyDraft("");
    void sendChatMessage(text, offeredTurnId && optionId ? { offeredTurnId, optionId } : undefined);
  };

  const startNewChat = () => {
    chatRequestAbortRef.current?.abort();
    chatRequestAbortRef.current = null;
    chatPinAnimationsRef.current.forEach((animation) => animation.stop());
    chatPinAnimationsRef.current = [];
    if (chatPinTimerRef.current !== undefined) {
      window.clearTimeout(chatPinTimerRef.current);
      chatPinTimerRef.current = undefined;
    }
    lastPinnedUserMessageIdRef.current = null;
    composerOriginTopRef.current = null;
    if (composerExpandTimerRef.current !== undefined) {
      window.clearTimeout(composerExpandTimerRef.current);
      composerExpandTimerRef.current = undefined;
    }
    setChatMessages([]);
    setActiveConversationId(undefined);
    setChatDraft("");
    setIsChatResponding(false);
    setChatHistoryOpen(false);
    setComposerExpanded(false);
    setChatClarification(null);
    setClarifyDraft("");
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

  return (
    <main
      className={`${styles.dash} ${collapsed ? styles.collapsed : ""}`}
      data-theme={theme}
    >
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.projectBrand}>
            <span className={styles.projectName}>Albert</span>
          </div>
          <button
            className={styles.collapseButton}
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((value) => !value)}
          >
            <Icon name="panel" />
          </button>
        </div>

        <label className={styles.searchBox}>
          <Icon name="search" />
          <input
            aria-label="Search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>⌘K</kbd>
        </label>

        <nav className={styles.navigation} aria-label="Project navigation">
          {filteredItems.length > 0 ? (
            filteredItems.map((item) => {
              const isActive = item.label === activeItem;
              return (
                <button
                  className={`${styles.navItem} ${isActive ? styles.active : ""}`}
                  key={item.label}
                  type="button"
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => {
                    setActiveItem(item.label);
                    setChatHistoryOpen(false);
                  }}
                >
                  <Icon name={item.icon} />
                  <span className={styles.navLabel}>{item.label}</span>
                </button>
              );
            })
          ) : (
            <p className={styles.noResults}>No matches</p>
          )}
        </nav>

        <div className={styles.accountArea} ref={accountAreaRef}>
          <div
            className={`${styles.accountPopover} ${accountOpen ? styles.accountPopoverOpen : ""}`}
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

            <button
              className={styles.accountWorkspace}
              type="button"
              onClick={() => {
                setActiveItem("Organization");
                setAccountOpen(false);
              }}
            >
              <span className={styles.accountAvatar}>{accountInitial}</span>
              <span className={styles.accountWorkspaceCopy}>
                <strong>{accountOrganisation.name}</strong>
                <small>{accountRoleLabel}</small>
              </span>
              <Icon name="chevron" />
            </button>

            <div className={styles.accountDivider} />

            <div className={styles.accountLinks}>
              <button
                type="button"
                onClick={() => {
                  setActiveItem("Organization");
                  setAccountOpen(false);
                }}
              ><Icon name="organization" /><span>Organization settings</span></button>
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

          <button
            className={styles.accountTrigger}
            type="button"
            aria-expanded={accountOpen}
            aria-haspopup="dialog"
            onClick={() => setAccountOpen((value) => !value)}
          >
            <span className={styles.accountAvatar}>{accountInitial}</span>
            <span className={styles.accountWorkspaceCopy}>
              <strong>{accountOrganisation.name}</strong>
              <small>{accountRoleLabel}</small>
            </span>
          </button>
        </div>
      </aside>

      <section className={styles.content} aria-labelledby="dash-title">
        <header className={`${styles.pageHeader} ${styles.pageHeaderSimple}`}>
          <div className={styles.pageHeaderTop}>
            <h1 id="dash-title">{activeItem}</h1>
          </div>
        </header>
        {tenantDeletionReceipt ? (
          <TenantDeletionWorkspace initialReceipt={tenantDeletionReceipt} />
        ) : activeItem === "Chat" ? (
          <div className={styles.chatShell}>
          <div
            className={`${styles.chatWorkspace} ${chatHistoryOpen ? styles.chatWorkspaceHistoryOpen : ""}`}
          >
            {chatMessages.length > 0 ? (
              <button
                className={styles.chatNewChat}
                type="button"
                onClick={startNewChat}
              >
                <Icon name="plus" />
                <span>New Chat</span>
              </button>
            ) : null}
            {chatMessages.length > 0 ? (
              <div className={styles.chatMessages} aria-live="polite" ref={chatMessagesRef}>
                {chatMessages.map((message) => {
                  const suppressEnter = Boolean(
                    reduceMotion || message.suppressEnter,
                  );
                  return (
                  <motion.article
                    className={`${styles.chatMessage} ${message.role === "assistant" ? styles.chatMessageAssistant : styles.chatMessageUser}`}
                    data-message-id={message.id}
                    key={message.id}
                    initial={suppressEnter ? false : { opacity: 0 }}
                    animate={suppressEnter ? false : { opacity: 1 }}
                    transition={{
                      duration: 0.34,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    {message.role === "assistant" ? (
                      <>
                        {message.events?.length ? (
                          <AnalyticalTrace
                            events={message.events}
                            streaming={message.isStreaming}
                            runtime={message.runtime}
                            lineageReference={message.conversationId && message.turnId ? {
                              conversationId: message.conversationId,
                              turnId: message.turnId,
                            } : undefined}
                            onFollowUp={(prompt) => void sendChatMessage(prompt)}
                            onClarification={(label, optionId) => answerClarification(label, message.turnId, optionId)}
                          />
                        ) : message.isStreaming ? (
                          <div className={styles.chatTraceConnecting} role="status">
                            <span aria-hidden="true" />
                            Opening a governed analysis…
                          </div>
                        ) : (
                          <span className={styles.chatMessageLabel}>Albert</span>
                        )}
                        {message.isStreaming ? null : message.text ? (
                          <motion.div
                            className={styles.chatMessageReveal}
                            initial={
                              reduceMotion || !message.animateReveal
                                ? false
                                : { opacity: 0, clipPath: "inset(0 0 100% 0)" }
                            }
                            animate={{ opacity: 1, clipPath: "inset(0 0 -8% 0)" }}
                            transition={{ duration: 2.2, ease: [0.22, 1, 0.36, 1] }}
                          >
                            <p>{message.text}</p>
                          </motion.div>
                        ) : null}
                      </>
                    ) : (
                      message.text ? <p>{message.text}</p> : null
                    )}
                  </motion.article>
                  );
                })}
                <div className={styles.chatScrollSpacer} ref={chatSpacerRef} aria-hidden="true" />
              </div>
            ) : (
              <div className={styles.chatEmptyGrow} aria-hidden="true" />
            )}

            {chatHistoryOpen ? (
              <section id="conversation-history" className={styles.chatHistoryPanel} aria-label="Conversation history">
                <div className={styles.chatHistoryHeader}>
                  <div>
                    <p className={styles.chatHistoryEyebrow}>CONVERSATIONS</p>
                    <h2>History</h2>
                  </div>
                  <button
                    className={styles.chatHistoryClose}
                    type="button"
                    aria-label="Close conversation history"
                    onClick={() => setChatHistoryOpen(false)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <div className={styles.chatHistoryList}>
                  {conversationHistoryStatus.kind === "loading" ? (
                    <p className={styles.chatHistoryState} role="status">
                      {conversationHistoryStatus.message || "Loading saved conversations…"}
                    </p>
                  ) : conversationHistoryStatus.kind === "error" ? (
                    <div className={styles.chatHistoryState} role="alert">
                      <p>{conversationHistoryStatus.message}</p>
                      <button type="button" onClick={() => void loadConversationSummaries()}>Try again</button>
                    </div>
                  ) : conversationSummaries.length === 0 ? (
                    <p className={styles.chatHistoryState}>Your governed conversations will appear here after the first question.</p>
                  ) : conversationSummaries.map((conversation) => (
                    <button
                      className={`${styles.chatHistoryItem} ${conversation.conversationId === activeConversationId ? styles.chatHistoryItemActive : ""}`}
                      type="button"
                      key={conversation.conversationId}
                      onClick={() => void openSavedConversation(conversation.conversationId)}
                    >
                      <span className={styles.chatHistoryItemIcon}><Icon name="chat" /></span>
                      <span className={styles.chatHistoryItemCopy}>
                        <strong>{conversation.title.slice(0, 80)}</strong>
                        <small>{conversationTimestamp(conversation.updatedAt)} · {conversation.status}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            <motion.div
              className={`${styles.chatComposerStack} ${chatComposerCompact ? styles.chatComposerStackHero : ""} ${chatComposerHero ? styles.chatComposerStackEmpty : ""} ${chatClarification ? styles.chatComposerStackConnected : ""}`}
            >
              <AnimatePresence initial={false}>
                {chatComposerHero ? (
                  <motion.h2
                    key="chat-hero-title"
                    className={styles.chatHeroTitle}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.32,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    Ask me anything
                  </motion.h2>
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

            <motion.form
              ref={chatComposerRef}
              className={`${styles.chatComposer} ${chatComposerCompact ? styles.chatComposerHero : ""}`}
              initial={false}
              animate={{
                borderRadius: chatComposerCompact ? 999 : 20,
                paddingTop: 12,
                paddingBottom: chatComposerCompact ? 12 : 10,
                paddingLeft: chatComposerCompact ? 20 : 13,
                paddingRight: chatComposerCompact ? 12 : 13,
              }}
              transition={{
                duration: reduceMotion ? 0 : 0.45,
                ease: [0.22, 1, 0.36, 1],
              }}
              onSubmit={(event) => {
                event.preventDefault();
                void sendChatMessage();
              }}
            >
              <div className={styles.chatComposerInputRow}>
                <textarea
                  aria-label="Ask me anything"
                  placeholder={chatComposerHero ? "Type a message…" : "Search or ask anything"}
                  rows={1}
                  value={chatDraft}
                  onFocus={() => {
                    if (chatMessages.length === 0) {
                      setComposerExpanded(true);
                    }
                  }}
                  onChange={(event) => setChatDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendChatMessage();
                    }
                  }}
                />
              </div>
              <>
                  <motion.div
                    className={styles.chatComposerFooter}
                    initial={false}
                    animate={{
                      height: chatComposerCompact ? 0 : 32,
                      marginTop: chatComposerCompact ? 0 : 10,
                      opacity: chatComposerCompact ? 0 : 1,
                    }}
                    transition={{
                      height: {
                        duration: reduceMotion ? 0 : 0.42,
                        ease: [0.22, 1, 0.36, 1],
                      },
                      marginTop: {
                        duration: reduceMotion ? 0 : 0.42,
                        ease: [0.22, 1, 0.36, 1],
                      },
                      opacity: {
                        duration: reduceMotion ? 0 : 0.28,
                        delay: reduceMotion || chatComposerCompact ? 0 : 0.12,
                        ease: "easeOut",
                      },
                    }}
                    style={{
                      overflow: chatComposerCompact ? "hidden" : "visible",
                    }}
                    aria-hidden={chatComposerCompact}
                    inert={chatComposerCompact || undefined}
                  >
                    <div className={styles.chatComposerTools}>
                      <button
                        className={styles.chatHistoryTrigger}
                        type="button"
                        tabIndex={chatComposerCompact ? -1 : undefined}
                        aria-expanded={chatHistoryOpen}
                        aria-controls="conversation-history"
                        onClick={() => {
                          const nextOpen = !chatHistoryOpen;
                          setChatHistoryOpen(nextOpen);
                          if (nextOpen) void loadConversationSummaries();
                        }}
                      >
                        <Icon name="panel" />
                        <span>History</span>
                      </button>
                      <ModelRunControls
                        value={agentPreferences}
                        onChange={setAgentPreferences}
                        runActive={isChatResponding}
                        compact
                      />
                    </div>
                  </motion.div>
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
                    aria-label={isChatResponding ? "Albert is responding" : "Send message"}
                    disabled={isChatResponding || !chatDraft.trim()}
                  >
                    <Icon name="arrowUp" />
                  </motion.button>
              </>
            </motion.form>
            </motion.div>

            <motion.div
              className={styles.chatEmptyGrow}
              aria-hidden="true"
              initial={false}
              animate={{ flexGrow: chatMessages.length === 0 ? 1 : 0 }}
              transition={{
                duration: reduceMotion ? 0 : 0.5,
                ease: [0.22, 1, 0.36, 1],
              }}
            />
          </div>

          </div>
        ) : activeItem === "Connections" ? (
          <ConnectionsWorkspace
            data={connectionsData}
            status={connectionsStatus}
            notice={oauthNotice}
            canManage={canManageConnections}
            onConnect={connectProvider}
            onAnswerBlockingQuestion={answerConnectionQuestion}
            onMatchDecision={decideConnectionMatch}
            onSelectOAuthAccount={selectOAuthAccount}
            onDisconnect={disconnectConnection}
          />
        ) : activeItem === "Admin" && isInternalOperator ? (
          <AdminWorkspace />
        ) : activeItem === "Organization" ? (
          <OrganizationWorkspace
            onOrganisationChanged={() => window.location.reload()}
            onOrganisationRenamed={(name) => setAccountOrganisation((current) => ({ ...current, name }))}
          />
        ) : (
          <div className={styles.contentBody}>
            <p className={styles.contentEyebrow}>ACCESS UNAVAILABLE</p>
            <h2>This area is not available for your current role.</h2>
            <p className={styles.contentDescription}>Choose Chat or Connections from the sidebar.</p>
          </div>
        )}
      </section>

    </main>
  );
}
