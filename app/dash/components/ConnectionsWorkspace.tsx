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

export const CONNECTION_VIEWS = ["apps", "readiness", "review"] as const;
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

export interface ConnectionProviderData {
  id: ConnectionProviderId;
  connectionId?: string;
  name: string;
  description: string;
  logo: string;
  auth: ConnectionAuthHealth;
  domains: readonly DomainReadiness[];
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
  initialView?: ConnectionViewId;
  onViewChange?: (view: ConnectionViewId) => void;
  onConnect?: (providerId: ConnectionProviderId) => void;
  onManage?: (providerId: ConnectionProviderId) => void;
  onAnswerBlockingQuestion?: (questionId: string, optionId: string) => void;
  onMatchDecision?: (matchId: string, decision: MatchDecision) => boolean | void | Promise<boolean | void>;
  onSelectOAuthAccount?: (oauthSessionId: string, externalAccountId: string) => void;
  onDisconnect?: (connectionId: string) => void;
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

export const albertConnectionsFixture: ConnectionsWorkspaceData = {
  tenantName: "Albert Cycle Co.",
  timezone: "Australia/Melbourne",
  syncSummary: {
    progress: 60,
    detail: "Recent data is prepared first. Deep history continues in the background.",
    latestActivityAt: "2026-08-03T00:42:00.000Z",
  },
  providers: [
    {
      id: "lightspeed",
      name: "Lightspeed",
      description: "Sales, inventory, customers, and store activity.",
      logo: "/logos/lightspeed.png",
      auth: {
        state: "healthy",
        label: "Connected",
        detail: "R-Series · 2 shops",
        accountName: "Albert Cycle Co.",
        checkedAt: "2026-08-03T00:41:00.000Z",
      },
      domains: [
        {
          id: "lightspeed-sales",
          label: "Sales",
          state: "ready_complete",
          detail: "Recent sales and 13 months of history have passed validation.",
          progress: 100,
          watermark: {
            label: "Ready through 10:42 am",
            at: "2026-08-03T00:42:00.000Z",
          },
        },
        {
          id: "lightspeed-inventory",
          label: "Inventory",
          state: "ready_partial",
          detail: "Current stock is queryable while movement history backfills.",
          progress: 72,
          watermark: {
            label: "Ready through 10:40 am",
            at: "2026-08-03T00:40:00.000Z",
          },
        },
        {
          id: "lightspeed-customers",
          label: "Customers",
          state: "validating",
          detail: "Checking identity coverage and duplicate customer records.",
          progress: 88,
        },
        {
          id: "lightspeed-products",
          label: "Product catalogue",
          state: "transforming",
          detail: "Mapping products, variants, and the category hierarchy.",
          progress: 81,
        },
      ],
    },
    {
      id: "xero",
      name: "Xero",
      description: "Accounting, invoices, journals, and bank activity.",
      logo: "/logos/xero.svg",
      auth: {
        state: "healthy",
        label: "Connected",
        detail: "Australian organisation · Accrual basis",
        accountName: "Albert Cycle Co Pty Ltd",
        checkedAt: "2026-08-03T00:38:00.000Z",
      },
      domains: [
        {
          id: "xero-accounting",
          label: "Accounting",
          state: "syncing",
          detail: "The current accounting period is loading before older journals.",
          progress: 63,
          watermark: {
            label: "Synced through 31 July",
            at: "2026-07-31T14:00:00.000Z",
          },
        },
        {
          id: "xero-cash",
          label: "Cash settlement",
          state: "degraded",
          detail: "Bank activity is available through Friday; the weekend deposit is pending.",
          progress: 76,
          watermark: {
            label: "Available through 1 August",
            at: "2026-08-01T14:00:00.000Z",
          },
        },
        {
          id: "xero-payables",
          label: "Payables",
          state: "not_started",
          detail: "Queued behind the current accounting period.",
          progress: 0,
        },
      ],
    },
    {
      id: "deputy",
      name: "Deputy",
      description: "Rosters, timesheets, leave, and workforce activity.",
      logo: "/logos/deputy.png",
      auth: {
        state: "reauth_required",
        label: "Reconnect required",
        detail: "Authorization expired; existing review items remain available.",
        accountName: "Albert Cycle Co.",
        checkedAt: "2026-08-03T00:36:00.000Z",
      },
      domains: [
        {
          id: "deputy-workforce",
          label: "Workforce",
          state: "blocked",
          detail: "Reconnect Deputy before rosters and timesheets can resume syncing.",
          progress: 0,
        },
      ],
    },
  ],
  dossier: [
    {
      id: "industry",
      label: "Business type",
      value: "Independent bicycle retailer",
      confidence: { label: "High", percent: 96 },
      provenance: "Lightspeed product category mix",
      observedAt: "2026-08-03T00:42:00.000Z",
    },
    {
      id: "locations",
      label: "Trading locations",
      value: "Brunswick and Fitzroy",
      confidence: { label: "High", percent: 100 },
      provenance: "Lightspeed Shops",
      observedAt: "2026-08-03T00:41:00.000Z",
    },
    {
      id: "gst",
      label: "GST registration",
      value: "Registered",
      confidence: { label: "High", percent: 100 },
      provenance: "Xero Organisation settings",
      observedAt: "2026-08-03T00:38:00.000Z",
    },
    {
      id: "accounting-basis",
      label: "Accounting basis",
      value: "Accrual",
      confidence: { label: "High", percent: 100 },
      provenance: "Xero Organisation settings",
      observedAt: "2026-08-03T00:38:00.000Z",
    },
  ],
  blockingQuestions: [
    {
      id: "sales-lens",
      label: "Default sales lens",
      question: "When you say sales, which figure should Albert use by default?",
      options: [
        { id: "ex-gst", label: "Excluding GST" },
        { id: "inc-gst", label: "Including GST" },
      ],
    },
    {
      id: "trading-day",
      label: "Trading-day cutoff",
      question: "When should a trading day end for overnight activity?",
      options: [
        { id: "midnight", label: "Midnight" },
        { id: "2am", label: "2 am" },
        { id: "4am", label: "4 am" },
      ],
      selectedOptionId: "2am",
    },
    {
      id: "employee-performance",
      label: "Employee performance",
      question: "What should performed best mean by default?",
      options: [
        { id: "net-sales", label: "Net sales" },
        { id: "gross-profit", label: "Gross profit" },
        { id: "profit-per-hour", label: "Sales per worked hour" },
      ],
    },
  ],
  identityMatches: [
    {
      id: "worker-jessica-chen",
      kind: "worker",
      title: "Is this the same team member?",
      first: {
        provider: "lightspeed",
        providerLabel: "Lightspeed",
        value: "Jessica Chen",
      },
      second: {
        provider: "deputy",
        providerLabel: "Deputy",
        value: "Jess C",
      },
      evidence: "Exact work email and the same Fitzroy location",
      confidence: "High",
      decision: "proposed",
      projectionStatus: "applied",
    },
    {
      id: "location-brunswick",
      kind: "location",
      title: "Do these names describe the same place?",
      first: {
        provider: "lightspeed",
        providerLabel: "Lightspeed",
        value: "Brunswick Shop",
      },
      second: {
        provider: "deputy",
        providerLabel: "Deputy",
        value: "Brunswick",
      },
      evidence: "Normalised street address matches exactly",
      confidence: "High",
      decision: "proposed",
      projectionStatus: "applied",
    },
  ],
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
      auth: Object.freeze({
        state: "not_connected" as const,
        label: "Not connected",
        detail: "Connect a Lightspeed Retail R-Series account.",
      }),
      domains: Object.freeze([]),
    }),
    Object.freeze({
      id: "xero" as const,
      name: "Xero",
      description: "Accounting, invoices, journals, and bank activity.",
      logo: "/logos/xero.svg",
      auth: Object.freeze({
        state: "not_connected" as const,
        label: "Not connected",
        detail: "Connect a Xero organisation.",
      }),
      domains: Object.freeze([]),
    }),
    Object.freeze({
      id: "deputy" as const,
      name: "Deputy",
      description: "Rosters, timesheets, leave, and workforce activity.",
      logo: "/logos/deputy.png",
      auth: Object.freeze({
        state: "not_connected" as const,
        label: "Not connected",
        detail: "Connect a Deputy installation.",
      }),
      domains: Object.freeze([]),
    }),
  ]),
  dossier: Object.freeze([]),
  blockingQuestions: Object.freeze([]),
  identityMatches: Object.freeze([]),
  oauthSelections: Object.freeze([]),
});

const viewLabels: Record<ConnectionViewId, string> = {
  apps: "Apps",
  readiness: "Readiness",
  review: "Review",
};

const queryableReadinessStates = new Set<ReadinessState>([
  "ready_partial",
  "ready_complete",
]);

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
}: {
  value?: number;
  label: string;
  state: ReadinessState;
}) {
  const determinate = typeof value === "number";
  const safeValue = determinate ? clampProgress(value) : undefined;
  const progressStyle = determinate
    ? ({ "--connections-progress": `${safeValue}%` } as CSSProperties)
    : undefined;

  return (
    <div
      className={styles.connectionsProgressTrack}
      data-state={state}
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
        style={progressStyle}
      />
    </div>
  );
}

function ProviderLogo({ provider }: { provider: ConnectionProviderData }) {
  return (
    <span className={styles.connectionsProviderLogo} data-provider={provider.id}>
      <Image src={provider.logo} alt="" width={24} height={24} />
    </span>
  );
}

export default function ConnectionsWorkspace(props: ConnectionsWorkspaceProps) {
  const data=props.data??emptyConnectionsWorkspace;
  const stateKey=[
    ...data.blockingQuestions.map((question)=>`q:${question.id}:${question.selectedOptionId??""}`),
    ...data.identityMatches.map((match)=>`m:${match.id}:${match.decision}:${match.projectionStatus}`),
  ].join("|");
  return <ConnectionsWorkspaceStateful key={stateKey} {...props} data={data} />;
}

function ConnectionsWorkspaceStateful({
  data = emptyConnectionsWorkspace,
  status = { kind: "ready" },
  initialView = "apps",
  onViewChange,
  onConnect,
  onManage,
  onAnswerBlockingQuestion,
  onMatchDecision,
  onSelectOAuthAccount,
  onDisconnect,
}: ConnectionsWorkspaceProps) {
  const [activeView, setActiveView] = useState<ConnectionViewId>(initialView);
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
  const [managedProviderId, setManagedProviderId] = useState<ConnectionProviderId | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const manageDialogRef = useRef<HTMLElement>(null);
  const managePreviousFocusRef = useRef<HTMLElement | null>(null);
  const managedProvider = data.providers.find(({ id }) => id === managedProviderId);

  const allDomains = useMemo(
    () => data.providers.flatMap((provider) => provider.domains),
    [data.providers],
  );
  const readyDomainCount = allDomains.filter((domain) =>
    queryableReadinessStates.has(domain.state),
  ).length;
  const openQuestionCount = data.blockingQuestions.filter(
    (question) => !answers[question.id],
  ).length;
  const proposedMatchCount = data.identityMatches.filter(
    (match) => matchDecisions[match.id] === "proposed",
  ).length;
  const reviewCount = openQuestionCount + proposedMatchCount;

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
    if (!managedProviderId) return;
    managePreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = manageDialogRef.current;
    dialog?.querySelector<HTMLElement>("button")?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setManagedProviderId(null);
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
  }, [managedProviderId]);

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

  const answerQuestion = (questionId: string, optionId: string) => {
    setAnswers((current) => ({ ...current, [questionId]: optionId }));
    onAnswerBlockingQuestion?.(questionId, optionId);
  };

  const decideMatch = async (matchId: string, decision: MatchDecision) => {
    const previousDecision = matchDecisions[matchId] ?? "proposed";
    const previousProjectionStatus = matchProjectionStatuses[matchId] ?? "applied";
    setMatchDecisions((current) => ({ ...current, [matchId]: decision }));
    setMatchProjectionStatuses((current) => ({ ...current, [matchId]: "pending" }));
    if (!onMatchDecision) {
      setMatchProjectionStatuses((current) => ({ ...current, [matchId]: "applied" }));
      return;
    }
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
        <div className={styles.connectionsTenantMeta}>
          <span>{data.tenantName}</span>
          <small>{data.timezone}</small>
        </div>
      </div>

      {status.kind !== "ready" ? (
        <div className={styles.connectionsPreviewNotice} data-status={status.kind} role="status">
          <span aria-hidden="true">✦</span>
          <p>
            <strong>{status.kind === "loading" ? "Loading your connections" : "Connection status unavailable"}</strong>
            {status.message ? ` · ${status.message}` : ""}
          </p>
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
          <section className={styles.connectionsSyncSummary} aria-labelledby={`${componentId}-sync-title`}>
            <div className={styles.connectionsSyncSummaryCopy}>
              <p className={styles.connectionsSectionEyebrow}>PROGRESSIVE SYNC</p>
              <h3 id={`${componentId}-sync-title`}>
                {readyDomainCount} of {allDomains.length} domains are queryable
              </h3>
              <p>{data.syncSummary.detail}</p>
            </div>
            <div className={styles.connectionsSyncSummaryProgress}>
              <div>
                <strong>{clampProgress(data.syncSummary.progress)}%</strong>
                <span>
                  {data.syncSummary.latestActivityAt
                    ? `Updated ${formatLocalTime(data.syncSummary.latestActivityAt, data.timezone)}`
                    : "Waiting for the first sync"}
                </span>
              </div>
              <ProgressBar
                value={data.syncSummary.progress}
                state="syncing"
                label="Overall setup progress"
              />
            </div>
          </section>

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
                    disabled={!onSelectOAuthAccount}
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
              const connected = provider.auth.state === "healthy";
              const authorizing = provider.auth.state === "authorizing";
              const needsReconnect =
                provider.auth.state === "reauth_required" || provider.auth.state === "error";
              const providerReadyCount = provider.domains.filter((domain) =>
                queryableReadinessStates.has(domain.state),
              ).length;

              return (
                <article className={styles.connectionsProviderRow} key={provider.id} role="listitem">
                  <div className={styles.connectionsProviderIdentity}>
                    <ProviderLogo provider={provider} />
                    <div className={styles.connectionsProviderCopy}>
                      <div className={styles.connectionsProviderTitleRow}>
                        <h3>{provider.name}</h3>
                        <span
                          className={styles.connectionsAuthStatus}
                          data-auth-state={provider.auth.state}
                        >
                          <i aria-hidden="true" />
                          {provider.auth.label}
                        </span>
                      </div>
                      <p>{provider.description}</p>
                      <small>
                        {provider.auth.accountName ? `${provider.auth.accountName} · ` : ""}
                        {connected
                          ? `${providerReadyCount} of ${provider.domains.length} domains queryable`
                          : provider.auth.detail}
                      </small>
                    </div>
                  </div>

                  <div className={styles.connectionsProviderActions}>
                    {connected ? (
                      <button
                        className={styles.connectionsProviderActionSecondary}
                        type="button"
                        disabled={!onManage && !onDisconnect}
                        onClick={() => {
                          if (onManage) onManage(provider.id);
                          else {
                            setManagedProviderId(provider.id);
                            setConfirmDisconnect(false);
                          }
                        }}
                      >
                        Manage
                      </button>
                    ) : (
                      <button
                        className={styles.connectionsProviderActionPrimary}
                        type="button"
                        aria-busy={authorizing}
                        disabled={authorizing || !onConnect}
                        title={!onConnect ? "OAuth authorization is not configured in this preview" : undefined}
                        onClick={() => onConnect?.(provider.id)}
                      >
                        {authorizing ? "Authorizing…" : needsReconnect ? "Reconnect" : "Connect"}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}

      {activeView === "readiness" ? (
        <div
          id={`${componentId}-readiness-panel`}
          className={styles.connectionsViewPanel}
          role="tabpanel"
          aria-labelledby={`${componentId}-readiness-tab`}
          tabIndex={0}
        >
          <div className={styles.connectionsSectionIntro}>
            <div>
              <p className={styles.connectionsSectionEyebrow}>DOMAIN READINESS</p>
              <h3>Recent value first, deep history next</h3>
            </div>
            <p>
              Every domain advances independently. Partial and degraded states are disclosed to
              Albert with each answer.
            </p>
          </div>

          <div className={styles.connectionsReadinessGroups}>
            {data.providers.map((provider) => (
              <section
                className={styles.connectionsReadinessGroup}
                key={provider.id}
                aria-labelledby={`${componentId}-${provider.id}-readiness-title`}
              >
                <div className={styles.connectionsReadinessGroupHeader}>
                  <ProviderLogo provider={provider} />
                  <div>
                    <h3 id={`${componentId}-${provider.id}-readiness-title`}>{provider.name}</h3>
                    <p>{provider.auth.detail}</p>
                  </div>
                </div>
                <div className={styles.connectionsDomainList} role="list">
                  {provider.domains.map((domain) => (
                    <article
                      className={styles.connectionsDomainRow}
                      data-state={domain.state}
                      key={domain.id}
                      role="listitem"
                    >
                      <div className={styles.connectionsDomainTopline}>
                        <div>
                          <h4>{domain.label}</h4>
                          <span
                            className={styles.connectionsReadinessStatus}
                            data-state={domain.state}
                          >
                            {readinessStateLabels[domain.state]}
                          </span>
                        </div>
                        {domain.watermark ? (
                          <time dateTime={domain.watermark.at}>{domain.watermark.label}</time>
                        ) : null}
                      </div>
                      <p>{domain.detail}</p>
                      {typeof domain.progress === "number" ||
                      ["syncing", "transforming", "validating"].includes(domain.state) ? (
                        <div className={styles.connectionsDomainProgress}>
                          <ProgressBar
                            value={domain.progress}
                            state={domain.state}
                            label={`${domain.label} progress`}
                          />
                          {typeof domain.progress === "number" ? (
                            <span>{clampProgress(domain.progress)}%</span>
                          ) : (
                            <span>Working</span>
                          )}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>
            ))}
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
              {data.blockingQuestions.map((question) => (
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
                          onClick={() => answerQuestion(question.id, option.id)}
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
              {data.identityMatches.map((match) => {
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
                            onClick={() => void decideMatch(match.id, "rejected")}
                          >
                            Keep separate
                          </button>
                          <button
                            className={styles.connectionsMatchPrimary}
                            type="button"
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
                            onClick={() => void decideMatch(match.id, "proposed")}
                          >
                            Undo decision
                          </button>
                          <button
                            className={styles.connectionsMatchPrimary}
                            type="button"
                            onClick={() => void decideMatch(match.id, decision)}
                          >
                            Retry change
                          </button>
                        </>
                      ) : (
                        <button
                          className={styles.connectionsMatchSecondary}
                          type="button"
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

      {managedProvider ? (
        <div
          className={styles.connectionsManageBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setManagedProviderId(null);
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
                setManagedProviderId(null);
                setConfirmDisconnect(false);
              }}
            >
              ×
            </button>
            <div className={styles.connectionsManageIdentity}>
              <ProviderLogo provider={managedProvider} />
              <div>
                <span>CONNECTED APP</span>
                <h3 id={`${componentId}-manage-title`}>{managedProvider.name}</h3>
                <p>{managedProvider.auth.accountName || managedProvider.auth.detail}</p>
              </div>
            </div>
            {confirmDisconnect ? (
              <div className={styles.connectionsDisconnectConfirm}>
                <strong>Disconnect {managedProvider.name}?</strong>
                <p>Syncing stops immediately. Credentials are revoked or destroyed, and tenant data enters the audited deletion workflow.</p>
                <div>
                  <button type="button" onClick={() => setConfirmDisconnect(false)}>Keep connected</button>
                  <button
                    type="button"
                    disabled={!managedProvider.connectionId || !onDisconnect}
                    onClick={() => {
                      if (managedProvider.connectionId) onDisconnect?.(managedProvider.connectionId);
                      setManagedProviderId(null);
                      setConfirmDisconnect(false);
                    }}
                  >
                    Confirm disconnect
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.connectionsManageActions}>
                <button type="button" onClick={() => onConnect?.(managedProvider.id)}>
                  <strong>Reauthorize connection</strong>
                  <span>Run the provider’s OAuth flow again without changing historical lineage.</span>
                </button>
                <button type="button" onClick={() => setConfirmDisconnect(true)}>
                  <strong>Disconnect and delete</strong>
                  <span>Stop syncs, destroy credentials, and schedule the scoped purge.</span>
                </button>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}
