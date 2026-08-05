"use client";

import {
  useId,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Image from "next/image";
import styles from "../dash.module.css";

export const CONNECTION_VIEWS = ["apps"] as const;
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
  canManage?: boolean;
  onConnect?: (providerId: ConnectionProviderId) => void;
  onManage?: (connectionId: string) => void;
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
  const fullyComplete =
    domains.length > 0
    && !workspaceSyncIsActive(domains)
    && summary.state === "ready_complete"
    && (typeof summary.progress !== "number" || summary.progress >= 100);

  if (fullyComplete) return null;

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
  canManage = false,
  onConnect,
  onManage,
  onSelectOAuthAccount,
  onDisconnect,
  onRetry,
}: ConnectionsWorkspaceProps) {
  const componentId = useId().replaceAll(":", "");
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

  const mutationsEnabled = canManage && status.kind === "ready";
  const disabledActionTitle = !canManage
    ? "Owner or manager access is required."
    : status.kind === "loading"
      ? "Connection status is still loading."
      : status.kind === "error"
        ? "Connection controls are unavailable until status recovers."
        : undefined;

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

  return (
    <section className={styles.connectionsDataWorkspace} aria-labelledby={`${componentId}-title`}>
      <div className={styles.connectionsDataHeader}>
        <div>
          <h2 id={`${componentId}-title`}>Connections</h2>
          <p>The systems behind every answer.</p>
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
          <p><strong>View only</strong> · An owner or manager can authorize sources.</p>
        </div>
      ) : null}

      <div className={styles.connectionsViewPanel}>
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
