"use client";

import {
  useId,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import Image from "next/image";
import styles from "../dash.module.css";

export const CONNECTION_VIEWS = ["apps", "review"] as const;
export type ConnectionViewId = (typeof CONNECTION_VIEWS)[number];

export const READINESS_STATES = [
  "not_started",
  "syncing",
  "transforming",
  "validating",
  "ready_partial",
  "ready_complete",
  "degraded",
  "blocked",
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const AUTH_HEALTH_STATES = [
  "not_connected",
  "authorizing",
  "healthy",
  "reauth_required",
  "error",
] as const;
export type AuthHealthState = (typeof AUTH_HEALTH_STATES)[number];

export type ConnectionProviderId = "lightspeed" | "xero" | "deputy";
export type MatchDecision = "proposed" | "accepted" | "rejected";

export interface ConnectionAuthHealth {
  state: AuthHealthState;
  label: string;
  detail: string;
  accountName?: string;
  checkedAt?: string;
}

export interface DomainReadiness {
  id: string;
  label: string;
  state: ReadinessState;
  detail: string;
  progress?: number;
  watermark?: {
    label: string;
    at: string;
  };
}

export interface ConnectionAccountData {
  connectionId: string;
  auth: ConnectionAuthHealth;
  domains: readonly DomainReadiness[];
}

export interface ConnectionProviderData {
  id: ConnectionProviderId;
  name: string;
  description: string;
  logo: string;
  connectDetail: string;
  additionalConnectionLabel?: string;
  connections: readonly ConnectionAccountData[];
}

export interface DossierFact {
  id: string;
  label: string;
  value: string;
  confidence: {
    label: "High" | "Medium" | "Low";
    percent: number;
  };
  provenance: string;
  observedAt: string;
}

export interface BlockingQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface BlockingQuestion {
  id: string;
  label: string;
  question: string;
  options: BlockingQuestionOption[];
  selectedOptionId?: string;
}

export interface IdentityMatch {
  id: string;
  kind: "worker" | "location" | "product_variant" | "customer_account" | "supplier";
  title: string;
  first: {
    provider: ConnectionProviderId;
    providerLabel: string;
    value: string;
  };
  second: {
    provider: ConnectionProviderId;
    providerLabel: string;
    value: string;
  };
  evidence: string;
  confidence: "High" | "Medium";
  decision: MatchDecision;
  projectionStatus: "pending" | "applied" | "failed";
}

const identityKindLabels: Readonly<Record<IdentityMatch["kind"], string>> = Object.freeze({
  worker: "Worker match",
  location: "Location match",
  product_variant: "Product match",
  customer_account: "Customer match",
  supplier: "Supplier match",
});

export interface ConnectionsWorkspaceData {
  tenantName: string;
  timezone: string;
  providers: readonly ConnectionProviderData[];
  syncSummary: {
    progress: number;
    detail: string;
    latestActivityAt?: string;
  };
  dossier: readonly DossierFact[];
  blockingQuestions: readonly BlockingQuestion[];
  identityMatches: readonly IdentityMatch[];
  oauthSelections?: readonly Readonly<{
    oauthSessionId: string;
    provider: ConnectionProviderId;
    providerLabel: string;
    expiresAt: string;
    accounts: readonly Readonly<{ id: string; label: string; detail?: string }>[];
  }>[];
}

export interface ConnectionsWorkspaceProps {
  data?: ConnectionsWorkspaceData;
  status?: Readonly<{
    kind: "loading" | "error" | "ready";
    message?: string;
  }>;
  notice?: Readonly<{
    kind: "success" | "info" | "error";
    message: string;
    detail?: string;
  }> | null;
  initialView?: ConnectionViewId;
  canManage?: boolean;
  onViewChange?: (view: ConnectionViewId) => void;
  onConnect?: (providerId: ConnectionProviderId) => void;
  onManage?: (connectionId: string) => void;
  onAnswerBlockingQuestion?: (
    questionId: string,
    optionId: string,
  ) => boolean | void | Promise<boolean | void>;
  onMatchDecision?: (matchId: string, decision: MatchDecision) => boolean | void | Promise<boolean | void>;
  onSelectOAuthAccount?: (oauthSessionId: string, externalAccountId: string) => void;
  onDisconnect?: (connectionId: string) => void;
  onRetry?: () => void;
}

export const readinessStateLabels: Record<ReadinessState, string> = {
  not_started: "Not started",
  syncing: "Syncing",
  transforming: "Transforming",
  validating: "Validating",
  ready_partial: "Ready partial",
  ready_complete: "Ready complete",
  degraded: "Degraded",
  blocked: "Blocked",
};


/** Truthful zero state used before the authenticated control plane responds. */
export const emptyConnectionsWorkspace: ConnectionsWorkspaceData = Object.freeze({
  tenantName: "Your organisation",
  timezone: "Australia/Melbourne",
  syncSummary: Object.freeze({
    progress: 0,
    detail: "Connect a source to begin the recent-first sync.",
  }),
  providers: Object.freeze([
    Object.freeze({
      id: "lightspeed" as const,
      name: "Lightspeed",
      description: "Sales, inventory, customers, and store activity.",
      logo: "/logos/lightspeed.png",
      connectDetail: "Connect a Lightspeed Retail R-Series account.",
      connections: Object.freeze([]),
    }),
    Object.freeze({
      id: "xero" as const,
      name: "Xero",
      description: "Accounting, invoices, journals, and bank activity.",
      logo: "/logos/xero.svg",
      connectDetail: "Connect a Xero organisation.",
      additionalConnectionLabel: "Add another Xero organisation",
      connections: Object.freeze([]),
    }),
    Object.freeze({
      id: "deputy" as const,
      name: "Deputy",
      description: "Rosters, timesheets, leave, and workforce activity.",
      logo: "/logos/deputy.png",
      connectDetail: "Connect a Deputy installation.",
      connections: Object.freeze([]),
    }),
  ]),
  dossier: Object.freeze([]),
  blockingQuestions: Object.freeze([]),
  identityMatches: Object.freeze([]),
  oauthSelections: Object.freeze([]),
});

const viewLabels: Record<ConnectionViewId, string> = {
  apps: "Apps",
  review: "Review",
};

const activeSyncStates = new Set<ReadinessState>([
  "syncing",
  "transforming",
  "validating",
]);

export function connectionSyncSummary(domains: readonly DomainReadiness[]) {
  if (domains.length === 0) {
    return { progress: undefined as number | undefined, state: "syncing" as ReadinessState };
  }

  const progressValues = domains.map((domain) => {
    if (typeof domain.progress === "number") return clampProgress(domain.progress);
    if (domain.state === "ready_complete") return 100;
    if (domain.state === "not_started") return 0;
    return undefined;
  });
  const known = progressValues.filter((value): value is number => typeof value === "number");
  const progress = known.length
    ? Math.round(known.reduce((total, value) => total + value, 0) / known.length)
    : undefined;

  const priority: readonly ReadinessState[] = [
    "blocked",
    "degraded",
    "syncing",
    "transforming",
    "validating",
    "ready_partial",
    "not_started",
    "ready_complete",
  ];
  const state = priority.find((candidate) => domains.some((domain) => domain.state === candidate))
    ?? "syncing";

  return { progress, state };
}

function clampProgress(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function formatLocalTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function ProgressBar({
  value,
  label,
  state,
  size = "default",
}: {
  value?: number;
  label: string;
  state: ReadinessState;
  size?: "default" | "fat";
}) {
  const determinate = typeof value === "number";
  const safeValue = determinate ? clampProgress(value) : undefined;
  const progressStyle = determinate
    ? ({ "--connections-progress": `${safeValue}%` } as CSSProperties)
    : undefined;
  const animating = !determinate || activeSyncStates.has(state) || (safeValue ?? 100) < 100;

  return (
    <div
      className={size === "fat" ? styles.connectionsProgressTrackFat : styles.connectionsProgressTrack}
      data-state={state}
      data-animating={animating || undefined}
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={safeValue}
      aria-valuetext={determinate ? `${safeValue}% complete` : "In progress"}
    >
      <span
        className={styles.connectionsProgressFill}
        data-indeterminate={!determinate || undefined}
        data-sheen={animating || undefined}
        style={progressStyle}
      />
    </div>
  );
}

export function ConnectionSyncProgress({
  accountLabel,
  domains,
  popupPlacement = "below",
  layout = "card",
}: {
  accountLabel: string;
  domains: readonly DomainReadiness[];
  popupPlacement?: "above" | "below";
  layout?: "card" | "sidebar";
}) {
  const summary = connectionSyncSummary(domains);

  return (
    <div
      className={layout === "sidebar" ? styles.sidebarSyncProgress : styles.connectionsCardSync}
      data-popup-placement={popupPlacement}
    >
      <div className={layout === "sidebar" ? styles.sidebarSyncBar : styles.connectionsCardSyncBar}>
        <ProgressBar
          value={summary.progress}
          state={summary.state}
          size="fat"
          label={`${accountLabel} sync progress`}
        />
      </div>

      <div className={styles.connectionsCardSyncPopup} role="tooltip">
        {domains.length === 0 ? (
          <p className={styles.connectionsCardSyncEmpty}>
            Domains appear here once the first sync begins.
          </p>
        ) : (
          <ul className={styles.connectionsCardSyncDomains}>
            {domains.map((domain) => {
              const showBar =
                typeof domain.progress === "number" ||
                activeSyncStates.has(domain.state) ||
                domain.state === "ready_partial" ||
                domain.state === "ready_complete" ||
                domain.state === "not_started";
              return (
                <li key={domain.id} className={styles.connectionsCardSyncDomain} data-state={domain.state}>
                  <div className={styles.connectionsCardSyncDomainTopline}>
                    <span>{domain.label}</span>
                    <small>{readinessStateLabels[domain.state]}</small>
                  </div>
                  {showBar ? (
                    <div className={styles.connectionsCardSyncDomainProgress}>
                      <ProgressBar
                        value={domain.progress}
                        state={domain.state}
                        size="fat"
                        label={`${accountLabel} ${domain.label} progress`}
                      />
                      <em>
                        {typeof domain.progress === "number"
                          ? `${clampProgress(domain.progress)}%`
                          : activeSyncStates.has(domain.state)
                            ? "Working"
                            : domain.state === "ready_complete"
                              ? "100%"
                              : "–"}
                      </em>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export function collectWorkspaceSyncDomains(
  providers: readonly ConnectionProviderData[],
): readonly DomainReadiness[] {
  const accounts = providers.flatMap((provider) =>
    provider.connections.map((connection) => ({
      connection,
      providerName: provider.name,
    })),
  );
  if (accounts.length === 0) return Object.freeze([]);
  if (accounts.length === 1) return accounts[0]!.connection.domains;
  return Object.freeze(
    accounts.flatMap(({ connection, providerName }) => {
      const accountLabel = connection.auth.accountName || providerName;
      return connection.domains.map((domain) => ({
        ...domain,
        id: `${connection.connectionId}:${domain.id}`,
        label: `${accountLabel} · ${domain.label}`,
      }));
    }),
  );
}

export function workspaceSyncIsActive(domains: readonly DomainReadiness[]): boolean {
  return domains.some(
    (domain) =>
      activeSyncStates.has(domain.state) ||
      domain.state === "ready_partial" ||
      domain.state === "not_started" ||
      (typeof domain.progress === "number" && domain.progress < 100),
  );
}

const commentaryStatePriority: Readonly<Record<ReadinessState, number>> = Object.freeze({
  blocked: 0,
  degraded: 1,
  syncing: 2,
  transforming: 3,
  validating: 4,
  ready_partial: 5,
  not_started: 6,
  ready_complete: 7,
});

/** Short rotating status lines for the sidebar sync strip. */
export function buildSidebarSyncCommentary(
  domains: readonly DomainReadiness[],
  syncSummary?: Readonly<{ detail: string; latestActivityAt?: string }>,
): readonly string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    lines.push(trimmed);
  };

  const ordered = [...domains].sort(
    (left, right) =>
      commentaryStatePriority[left.state] - commentaryStatePriority[right.state],
  );

  for (const domain of ordered) {
    const complete =
      domain.state === "ready_complete" &&
      (typeof domain.progress !== "number" || domain.progress >= 100);
    if (complete) continue;

    const percent =
      typeof domain.progress === "number" ? ` · ${clampProgress(domain.progress)}%` : "";
    push(`${domain.label} · ${readinessStateLabels[domain.state]}${percent}`);

    if (domain.watermark?.label) {
      push(`${domain.label} · ${domain.watermark.label}`);
    }

    const genericDetail = domain.state.replaceAll("_", " ");
    if (
      domain.detail &&
      domain.detail !== genericDetail &&
      domain.detail !== readinessStateLabels[domain.state]
    ) {
      push(`${domain.label} · ${domain.detail}`);
    }
  }

  const finished = domains.filter((domain) => domain.state === "ready_complete");
  if (finished.length > 0 && finished.length < domains.length) {
    push(`${finished.length} of ${domains.length} domains ready`);
  }

  if (syncSummary?.detail) push(syncSummary.detail);

  if (lines.length === 0) {
    push(
      domains.length > 0
        ? "All connected domains are ready."
        : "Connect a source to begin syncing.",
    );
  }

  return Object.freeze(lines);
}

function ProviderLogo({ provider }: { provider: ConnectionProviderData }) {
  return (
    <span className={styles.connectionsProviderLogo} data-provider={provider.id}>
      <Image src={provider.logo} alt="" width={24} height={24} unoptimized />
    </span>
  );
}

export default function ConnectionsWorkspace(props: ConnectionsWorkspaceProps) {
  const data = props.data ?? emptyConnectionsWorkspace;
  const stateKey = [
    ...data.providers.flatMap((provider) =>
      provider.connections.map((connection) =>
        `c:${connection.connectionId}:${connection.auth.state}`
      )
    ),
    ...data.blockingQuestions.map((question) =>
      `q:${question.id}:${question.selectedOptionId ?? ""}`
    ),
    ...data.identityMatches.map((match) =>
      `m:${match.id}:${match.decision}:${match.projectionStatus}`
    ),
  ].join("|");
  return <ConnectionsWorkspaceStateful key={stateKey} {...props} data={data} />;
}

function ConnectionsWorkspaceStateful({
  data = emptyConnectionsWorkspace,
  status = { kind: "ready" },
  notice = null,
  initialView = "apps",
  canManage = false,
  onViewChange,
  onConnect,
  onManage,
  onAnswerBlockingQuestion,
  onMatchDecision,
  onSelectOAuthAccount,
  onDisconnect,
  onRetry,
}: ConnectionsWorkspaceProps) {
  const [activeView, setActiveView] = useState<ConnectionViewId>(
    initialView === "review" ? "review" : "apps",
  );
  const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0 });
  const tabListRef = useRef<HTMLDivElement>(null);
  const componentId = useId().replaceAll(":", "");
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      data.blockingQuestions.flatMap((question) =>
        question.selectedOptionId ? [[question.id, question.selectedOptionId]] : [],
      ),
    ),
  );
  const [matchDecisions, setMatchDecisions] = useState<Record<string, MatchDecision>>(() =>
    Object.fromEntries(data.identityMatches.map((match) => [match.id, match.decision])),
  );
  const [matchProjectionStatuses, setMatchProjectionStatuses] = useState<Record<string, IdentityMatch["projectionStatus"]>>(() =>
    Object.fromEntries(data.identityMatches.map((match) => [match.id, match.projectionStatus])),
  );
  const [pendingQuestionId, setPendingQuestionId] = useState<string | null>(null);
  const [managedConnectionId, setManagedConnectionId] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const manageDialogRef = useRef<HTMLElement>(null);
  const managePreviousFocusRef = useRef<HTMLElement | null>(null);
  const disconnectCancelRef = useRef<HTMLButtonElement>(null);
  const managedConnection = useMemo(() => {
    if (!managedConnectionId) return undefined;
    for (const provider of data.providers) {
      const connection = provider.connections.find(({ connectionId }) => connectionId === managedConnectionId);
      if (connection) return { provider, connection } as const;
    }
    return undefined;
  }, [data.providers, managedConnectionId]);

  const openQuestionCount = data.blockingQuestions.filter(
    (question) => !answers[question.id],
  ).length;
  const proposedMatchCount = data.identityMatches.filter(
    (match) => matchDecisions[match.id] === "proposed",
  ).length;
  const reviewCount = openQuestionCount + proposedMatchCount;
  const mutationsEnabled = canManage && status.kind === "ready";
  const disabledActionTitle = !canManage
    ? "Owner or manager access is required."
    : status.kind === "loading"
      ? "Connection status is still loading."
      : status.kind === "error"
        ? "Connection controls are unavailable until status recovers."
        : undefined;

  useLayoutEffect(() => {
    const container = tabListRef.current;
    if (!container) return;

    const updateIndicator = () => {
      const activeButton = container.querySelector<HTMLButtonElement>(
        `[data-view="${activeView}"]`,
      );
      if (!activeButton) return;
      const containerRect = container.getBoundingClientRect();
      const buttonRect = activeButton.getBoundingClientRect();
      setTabIndicator({
        left: buttonRect.left - containerRect.left,
        width: buttonRect.width,
      });
    };

    updateIndicator();
    const observer = new ResizeObserver(updateIndicator);
    observer.observe(container);
    window.addEventListener("resize", updateIndicator);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateIndicator);
    };
  }, [activeView]);

  useEffect(() => {
    if (!managedConnectionId) return;
    managePreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = manageDialogRef.current;
    dialog?.querySelector<HTMLElement>("button")?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setManagedConnectionId(null);
        setConfirmDisconnect(false);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled)")];
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
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      managePreviousFocusRef.current?.focus();
    };
  }, [managedConnectionId]);

  useEffect(() => {
    if (!managedConnectionId || !confirmDisconnect) return;
    const focusFrame = window.requestAnimationFrame(() => disconnectCancelRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [confirmDisconnect, managedConnectionId]);

  const selectView = (view: ConnectionViewId, focus = false) => {
    setActiveView(view);
    onViewChange?.(view);
    if (focus) {
      window.requestAnimationFrame(() => {
        tabListRef.current
          ?.querySelector<HTMLButtonElement>(`[data-view="${view}"]`)
          ?.focus();
      });
    }
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentView: ConnectionViewId,
  ) => {
    const currentIndex = CONNECTION_VIEWS.indexOf(currentView);
    let nextIndex = currentIndex;

    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % CONNECTION_VIEWS.length;
    else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + CONNECTION_VIEWS.length) % CONNECTION_VIEWS.length;
    } else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = CONNECTION_VIEWS.length - 1;
    else return;

    event.preventDefault();
    selectView(CONNECTION_VIEWS[nextIndex], true);
  };

  const answerQuestion = async (questionId: string, optionId: string) => {
    if (!mutationsEnabled || !onAnswerBlockingQuestion || pendingQuestionId) return;
    const previousOptionId = answers[questionId];
    setAnswers((current) => ({ ...current, [questionId]: optionId }));
    setPendingQuestionId(questionId);
    try {
      const saved = await onAnswerBlockingQuestion(questionId, optionId);
      if (saved === false) {
        setAnswers((current) => {
          const next = { ...current };
          if (previousOptionId) next[questionId] = previousOptionId;
          else delete next[questionId];
          return next;
        });
      }
    } catch {
      setAnswers((current) => {
        const next = { ...current };
        if (previousOptionId) next[questionId] = previousOptionId;
        else delete next[questionId];
        return next;
      });
    } finally {
      setPendingQuestionId(null);
    }
  };

  const decideMatch = async (matchId: string, decision: MatchDecision) => {
    if (!mutationsEnabled || !onMatchDecision) return;
    const previousDecision = matchDecisions[matchId] ?? "proposed";
    const previousProjectionStatus = matchProjectionStatuses[matchId] ?? "applied";
    setMatchDecisions((current) => ({ ...current, [matchId]: decision }));
    setMatchProjectionStatuses((current) => ({ ...current, [matchId]: "pending" }));
    try {
      const saved = await onMatchDecision(matchId, decision);
      if (saved === false) {
        setMatchDecisions((current) => ({ ...current, [matchId]: previousDecision }));
        setMatchProjectionStatuses((current) => ({ ...current, [matchId]: previousProjectionStatus }));
      }
    } catch {
      setMatchDecisions((current) => ({ ...current, [matchId]: previousDecision }));
      setMatchProjectionStatuses((current) => ({ ...current, [matchId]: previousProjectionStatus }));
    }
  };

  return (
    <section className={styles.connectionsDataWorkspace} aria-labelledby={`${componentId}-title`}>
      <div className={styles.connectionsDataHeader}>
        <div>
          <h2 id={`${componentId}-title`}>Your business data, coming together</h2>
          <p>
            Bring your business systems together, then follow each domain from connection to
            query-ready data.
          </p>
        </div>
      </div>

      {status.kind !== "ready" ? (
        <div className={styles.connectionsNotice} data-kind={status.kind === "error" ? "error" : "info"} role="status">
          <span aria-hidden="true">✦</span>
          <p>
            <strong>{status.kind === "loading" ? "Loading your connections" : "Connection status unavailable"}</strong>
            {status.message ? ` · ${status.message}` : ""}
          </p>
          {status.kind === "error" && onRetry ? (
            <button type="button" onClick={onRetry}>Try again</button>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <div className={styles.connectionsNotice} data-kind={notice.kind} role={notice.kind === "error" ? "alert" : "status"}>
          <span aria-hidden="true">{notice.kind === "success" ? "✓" : notice.kind === "error" ? "!" : "✦"}</span>
          <div className={styles.connectionsNoticeBody}>
            <p>{notice.message}</p>
            {notice.detail ? (
              <pre className={styles.connectionsNoticeDetail}>{notice.detail}</pre>
            ) : null}
          </div>
        </div>
      ) : null}

      {status.kind === "ready" && !canManage ? (
        <div className={styles.connectionsNotice} data-kind="info" role="status">
          <span aria-hidden="true">✦</span>
          <p><strong>View only</strong> · An owner or manager can authorize sources and confirm onboarding decisions.</p>
        </div>
      ) : null}

      <div
        className={styles.connectionsViewTabs}
        ref={tabListRef}
        role="tablist"
        aria-label="Connection views"
      >
        {CONNECTION_VIEWS.map((view) => {
          const selected = activeView === view;
          return (
            <button
              id={`${componentId}-${view}-tab`}
              className={`${styles.connectionsViewTab} ${selected ? styles.connectionsViewTabActive : ""}`}
              data-view={view}
              key={view}
              type="button"
              role="tab"
              tabIndex={selected ? 0 : -1}
              aria-selected={selected}
              aria-controls={`${componentId}-${view}-panel`}
              onClick={() => selectView(view)}
              onKeyDown={(event) => handleTabKeyDown(event, view)}
            >
              <span>{viewLabels[view]}</span>
              {view === "review" && reviewCount > 0 ? (
                <small aria-label={`${reviewCount} items to review`}>{reviewCount}</small>
              ) : null}
            </button>
          );
        })}
        <span
          className={styles.connectionsViewIndicator}
          style={{ left: tabIndicator.left, width: tabIndicator.width }}
          aria-hidden="true"
        />
      </div>

      {activeView === "apps" ? (
        <div
          id={`${componentId}-apps-panel`}
          className={styles.connectionsViewPanel}
          role="tabpanel"
          aria-labelledby={`${componentId}-apps-tab`}
          tabIndex={0}
        >
          {data.oauthSelections?.map((selection) => (
            <section className={styles.connectionsAccountSelection} key={selection.oauthSessionId} aria-labelledby={`${componentId}-${selection.oauthSessionId}-title`}>
              <div>
                <p className={styles.connectionsSectionEyebrow}>ACCOUNT SELECTION</p>
                <h3 id={`${componentId}-${selection.oauthSessionId}-title`}>Choose the {selection.providerLabel} account to connect</h3>
                <p>Albert found more than one account. Nothing will sync until you choose one.</p>
              </div>
              <div role="group" aria-label={`Available ${selection.providerLabel} accounts`}>
                {selection.accounts.map((account) => (
                  <button
                    key={account.id}
                    type="button"
                    disabled={!mutationsEnabled || !onSelectOAuthAccount}
                    title={disabledActionTitle}
                    onClick={() => onSelectOAuthAccount?.(selection.oauthSessionId, account.id)}
                  >
                    <strong>{account.label}</strong>
                    {account.detail ? <span>{account.detail}</span> : null}
                  </button>
                ))}
              </div>
            </section>
          ))}

          <div className={styles.connectionsProviderList} role="list" aria-label="Connected apps">
            {data.providers.map((provider) => {
              const selectionInProgress = data.oauthSelections?.some(
                (selection) => selection.provider === provider.id,
              ) ?? false;

              return (
                <section
                  className={styles.connectionsProviderGroup}
                  key={provider.id}
                  role="listitem"
                  aria-label={`${provider.name} connections`}
                >
                  <div role="list" aria-label={`${provider.name} accounts`}>
                    {provider.connections.length === 0 ? (
                      <article className={styles.connectionsProviderRow} role="listitem">
                        <div className={styles.connectionsProviderMain}>
                          <div className={styles.connectionsProviderIdentity}>
                            <ProviderLogo provider={provider} />
                            <div className={styles.connectionsProviderCopy}>
                              <div className={styles.connectionsProviderTitleRow}>
                                <h3>{provider.name}</h3>
                                <span className={styles.connectionsAuthStatus} data-auth-state="not_connected">
                                  <i aria-hidden="true" />
                                  Not connected
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className={styles.connectionsProviderActions}>
                            <button
                              className={styles.connectionsProviderActionPrimary}
                              type="button"
                              aria-busy={selectionInProgress}
                              disabled={selectionInProgress || !mutationsEnabled || !onConnect}
                              title={disabledActionTitle}
                              onClick={() => onConnect?.(provider.id)}
                            >
                              {selectionInProgress ? "Choosing account…" : "Connect"}
                            </button>
                          </div>
                        </div>
                      </article>
                    ) : (
                      provider.connections.map((connection) => {
                        const authorizing = connection.auth.state === "authorizing";
                        const accountLabel = connection.auth.accountName || provider.name;
                        return (
                          <article
                            className={styles.connectionsProviderRow}
                            key={connection.connectionId}
                            role="listitem"
                            data-connection-id={connection.connectionId}
                            data-has-sync={connection.domains.length > 0 || authorizing || undefined}
                          >
                            <div className={styles.connectionsProviderMain}>
                              <div className={styles.connectionsProviderIdentity}>
                                <ProviderLogo provider={provider} />
                                <div className={styles.connectionsProviderCopy}>
                                  <div className={styles.connectionsProviderTitleRow}>
                                    <h3>{provider.name}</h3>
                                    <span
                                      className={styles.connectionsAuthStatus}
                                      data-auth-state={connection.auth.state}
                                    >
                                      <i aria-hidden="true" />
                                      {connection.auth.label}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <ConnectionSyncProgress
                                accountLabel={accountLabel}
                                domains={connection.domains}
                              />
                              <div className={styles.connectionsProviderActions}>
                                <button
                                  className={styles.connectionsProviderActionSecondary}
                                  type="button"
                                  aria-busy={authorizing}
                                  disabled={
                                    authorizing ||
                                    !mutationsEnabled ||
                                    (!onManage && !onConnect && !onDisconnect)
                                  }
                                  title={disabledActionTitle}
                                  onClick={() => {
                                    if (onManage) onManage(connection.connectionId);
                                    else {
                                      setManagedConnectionId(connection.connectionId);
                                      setConfirmDisconnect(false);
                                    }
                                  }}
                                >
                                  {authorizing ? "Authorizing…" : "Manage"}
                                </button>
                              </div>
                            </div>
                          </article>
                        );
                      })
                    )}
                  </div>
                  {provider.additionalConnectionLabel && provider.connections.length > 0 ? (
                    <button
                      className={styles.connectionsProviderAddAction}
                      type="button"
                      aria-busy={selectionInProgress}
                      disabled={selectionInProgress || !mutationsEnabled || !onConnect}
                      title={disabledActionTitle}
                      onClick={() => onConnect?.(provider.id)}
                    >
                      <span aria-hidden="true">+</span>
                      {provider.additionalConnectionLabel}
                    </button>
                  ) : null}
                </section>
              );
            })}
          </div>
        </div>
      ) : null}

      {activeView === "review" ? (
        <div
          id={`${componentId}-review-panel`}
          className={styles.connectionsViewPanel}
          role="tabpanel"
          aria-labelledby={`${componentId}-review-tab`}
          tabIndex={0}
        >
          <section className={styles.connectionsReviewSection} aria-labelledby={`${componentId}-dossier-title`}>
            <div className={styles.connectionsSectionIntro}>
              <div>
                <p className={styles.connectionsSectionEyebrow}>BUSINESS DOSSIER</p>
                <h3 id={`${componentId}-dossier-title`}>What Albert has learned</h3>
              </div>
              <p>Every inferred fact keeps its source, observation time, and confidence.</p>
            </div>
            {data.dossier.length === 0 ? (
              <p className={styles.connectionsEmptyState}>
                Albert will publish sourced business facts here after connected data passes its first transformation.
              </p>
            ) : (
              <dl className={styles.connectionsDossierList}>
                {data.dossier.map((fact) => (
                <div className={styles.connectionsDossierFact} key={fact.id}>
                  <dt>{fact.label}</dt>
                  <dd>
                    <strong>{fact.value}</strong>
                    <span data-confidence={fact.confidence.label.toLowerCase()}>
                      {fact.confidence.label} confidence · {fact.confidence.percent}%
                    </span>
                    <small>
                      {fact.provenance} ·{" "}
                      <time dateTime={fact.observedAt}>
                        {formatLocalTime(fact.observedAt, data.timezone)}
                      </time>
                    </small>
                  </dd>
                </div>
                ))}
              </dl>
            )}
          </section>

          <section className={styles.connectionsReviewSection} aria-labelledby={`${componentId}-questions-title`}>
            <div className={styles.connectionsSectionIntro}>
              <div>
                <p className={styles.connectionsSectionEyebrow}>BLOCKING QUESTIONS</p>
                <h3 id={`${componentId}-questions-title`}>Set the defaults that change an answer</h3>
              </div>
              <p>Albert asks only where two reasonable choices would materially differ.</p>
            </div>
            <div className={styles.connectionsQuestionList}>
              {data.blockingQuestions.length === 0 ? (
                <p className={styles.connectionsEmptyState}>No blocking decisions are required for the sources connected so far.</p>
              ) : data.blockingQuestions.map((question) => (
                <article className={styles.connectionsQuestionRow} key={question.id}>
                  <div className={styles.connectionsQuestionCopy}>
                    <span>{question.label}</span>
                    <h4>{question.question}</h4>
                  </div>
                  <div
                    className={styles.connectionsQuestionOptions}
                    role="group"
                    aria-label={question.question}
                  >
                    {question.options.map((option) => {
                      const selected = answers[question.id] === option.id;
                      return (
                        <button
                          className={selected ? styles.connectionsQuestionOptionSelected : ""}
                          key={option.id}
                          type="button"
                          aria-pressed={selected}
                          aria-busy={pendingQuestionId === question.id}
                          disabled={!mutationsEnabled || !onAnswerBlockingQuestion || pendingQuestionId !== null}
                          title={disabledActionTitle}
                          onClick={() => void answerQuestion(question.id, option.id)}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className={styles.connectionsReviewSection} aria-labelledby={`${componentId}-matches-title`}>
            <div className={styles.connectionsSectionIntro}>
              <div>
                <p className={styles.connectionsSectionEyebrow}>IDENTITY REVIEW</p>
                <h3 id={`${componentId}-matches-title`}>Confirm cross-system matches</h3>
              </div>
              <p>Confirmations are explicit and reversible; display names are never joined silently.</p>
            </div>
            <div className={styles.connectionsMatchList}>
              {data.identityMatches.length === 0 ? (
                <p className={styles.connectionsEmptyState}>No cross-system identity suggestions need review.</p>
              ) : data.identityMatches.map((match) => {
                const decision = matchDecisions[match.id] ?? match.decision;
                const projectionStatus = matchProjectionStatuses[match.id] ?? match.projectionStatus;
                return (
                  <article
                    className={styles.connectionsMatchCard}
                    data-decision={decision}
                    data-projection-status={projectionStatus}
                    key={match.id}
                  >
                    <div className={styles.connectionsMatchHeader}>
                      <div>
                        <span>{identityKindLabels[match.kind]}</span>
                        <h4>{match.title}</h4>
                      </div>
                      <span className={styles.connectionsMatchDecision} data-decision={decision} role="status">
                        {projectionStatus === "pending"
                          ? "Applying…"
                          : projectionStatus === "failed"
                            ? "Projection failed"
                            : decision === "accepted"
                          ? "Matched"
                          : decision === "rejected"
                            ? "Kept separate"
                            : "Needs review"}
                      </span>
                    </div>

                    <div className={styles.connectionsMatchPair}>
                      {[match.first, match.second].map((source) => (
                        <div key={`${match.id}-${source.provider}`}>
                          <span>{source.providerLabel}</span>
                          <strong>{source.value}</strong>
                        </div>
                      ))}
                    </div>

                    <div className={styles.connectionsMatchEvidence}>
                      <span>{match.confidence} confidence</span>
                      <p>{match.evidence}</p>
                    </div>

                    <div className={styles.connectionsMatchActions}>
                      {projectionStatus === "pending" ? (
                        <button className={styles.connectionsMatchSecondary} type="button" disabled>
                          Applying decision…
                        </button>
                      ) : decision === "proposed" ? (
                        <>
                          <button
                            className={styles.connectionsMatchSecondary}
                            type="button"
                            disabled={!mutationsEnabled || !onMatchDecision}
                            title={disabledActionTitle}
                            onClick={() => void decideMatch(match.id, "rejected")}
                          >
                            Keep separate
                          </button>
                          <button
                            className={styles.connectionsMatchPrimary}
                            type="button"
                            disabled={!mutationsEnabled || !onMatchDecision}
                            title={disabledActionTitle}
                            onClick={() => void decideMatch(match.id, "accepted")}
                          >
                            Confirm match
                          </button>
                        </>
                      ) : projectionStatus === "failed" ? (
                        <>
                          <button
                            className={styles.connectionsMatchSecondary}
                            type="button"
                            disabled={!mutationsEnabled || !onMatchDecision}
                            title={disabledActionTitle}
                            onClick={() => void decideMatch(match.id, "proposed")}
                          >
                            Undo decision
                          </button>
                          <button
                            className={styles.connectionsMatchPrimary}
                            type="button"
                            disabled={!mutationsEnabled || !onMatchDecision}
                            title={disabledActionTitle}
                            onClick={() => void decideMatch(match.id, decision)}
                          >
                            Retry change
                          </button>
                        </>
                      ) : (
                        <button
                          className={styles.connectionsMatchSecondary}
                          type="button"
                          disabled={!mutationsEnabled || !onMatchDecision}
                          title={disabledActionTitle}
                          onClick={() => void decideMatch(match.id, "proposed")}
                        >
                          Undo decision
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}

      {managedConnection ? (
        <div
          className={styles.connectionsManageBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setManagedConnectionId(null);
              setConfirmDisconnect(false);
            }
          }}
        >
          <section
            className={styles.connectionsManageDialog}
            ref={manageDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${componentId}-manage-title`}
          >
            <button
              className={styles.connectionsManageClose}
              type="button"
              aria-label="Close connection settings"
              onClick={() => {
                setManagedConnectionId(null);
                setConfirmDisconnect(false);
              }}
            >
              ×
            </button>
            <div className={styles.connectionsProviderIdentity}>
              <ProviderLogo provider={managedConnection.provider} />
              <div className={styles.connectionsProviderCopy}>
                <div className={styles.connectionsProviderTitleRow}>
                  <h3 id={`${componentId}-manage-title`}>{managedConnection.provider.name}</h3>
                </div>
                <small>
                  {managedConnection.connection.auth.accountName ||
                    managedConnection.connection.auth.detail}
                </small>
              </div>
            </div>
            {confirmDisconnect ? (
              <div className={styles.connectionsDisconnectConfirm}>
                <p>
                  Disconnect {managedConnection.connection.auth.accountName || managedConnection.provider.name}?
                </p>
                <div>
                  <button
                    className={styles.connectionsProviderActionSecondary}
                    ref={disconnectCancelRef}
                    type="button"
                    onClick={() => setConfirmDisconnect(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className={styles.connectionsManageActionDanger}
                    type="button"
                    disabled={!mutationsEnabled || !onDisconnect}
                    onClick={() => {
                      onDisconnect?.(managedConnection.connection.connectionId);
                      setManagedConnectionId(null);
                      setConfirmDisconnect(false);
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.connectionsManageActions}>
                <button
                  className={styles.connectionsProviderActionSecondary}
                  type="button"
                  disabled={!mutationsEnabled || !onConnect}
                  onClick={() => onConnect?.(managedConnection.provider.id)}
                >
                  Refresh authorization
                </button>
                <button
                  className={styles.connectionsManageActionDanger}
                  type="button"
                  disabled={!mutationsEnabled || !onDisconnect}
                  onClick={() => setConfirmDisconnect(true)}
                >
                  Disconnect
                </button>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}
