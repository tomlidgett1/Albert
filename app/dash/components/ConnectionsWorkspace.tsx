"use client";

import {
  useCallback,
  useId,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Image from "next/image";
import styles from "../dash.module.css";
import {
  activeSyncStates,
  clampProgress,
  connectionCardStatus,
  connectionShowsSyncProgress,
  connectionSyncSummary,
  readinessStateLabels,
} from "./connection-sync";

export {
  connectionCardStatus,
  connectionIngestionIsPending,
  connectionShowsSyncProgress,
  connectionSyncSummary,
  readinessStateLabels,
  workspaceSyncIsActive,
} from "./connection-sync";

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

export type ConnectionProviderId =
  | "lightspeed"
  | "lightspeed-x"
  | "xero"
  | "deputy"
  | "shopify"
  | "employment_hero"
  | "stripe"
  | "square"
  | "myob"
  | "momence"
  | "google_ads"
  | "meta_ads"
  | "tiktok_ads"
  | "google_analytics"
  | "paypal"
  | "afterpay"
  | "tyro"
  | "klaviyo"
  | "woocommerce"
  | "servicem8";
export type MatchDecision = "proposed" | "accepted" | "rejected";
export type ConnectableProviderId =
  | "lightspeed" | "lightspeed-x" | "xero" | "deputy" | "square"
  | "shopify" | "stripe" | "momence" | "meta-ads" | "google-ads";

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
  ingestionState?: "inactive" | "awaiting_manual_start" | "queued" | "running" | "active";
  manualIngestionStartRequired?: boolean;
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
  comingSoon?: boolean;
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
  onConnect?: (providerId: ConnectionProviderId, shopDomain?: string) => void;
  onManage?: (connectionId: string) => void;
  onSelectOAuthAccount?: (oauthSessionId: string, externalAccountId: string) => void;
  onDisconnect?: (connectionId: string) => void;
  onIngestionStarted?: () => void;
  onRetry?: () => void;
}

type ManualSyncState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "accepted"; syncRunId: string }
  | { status: "declined"; message: string };

export const COMING_SOON_PROVIDERS: readonly ConnectionProviderData[] = Object.freeze([
  Object.freeze({
    id: "employment_hero" as const,
    name: "Employment Hero",
    description: "HR, payroll, and people operations.",
    logo: "/logos/employment-hero.png",
    connectDetail: "Employment Hero support is coming soon.",
    comingSoon: true,
    connections: Object.freeze([]),
  }),
  Object.freeze({
    id: "stripe" as const,
    name: "Stripe",
    description: "Payments, payouts, and online commerce activity.",
    logo: "/logos/stripe.svg",
    connectDetail: "Stripe support is coming soon.",
    comingSoon: true,
    connections: Object.freeze([]),
  }),
  Object.freeze({
    id: "myob" as const,
    name: "MYOB",
    description: "Accounting, invoices, and Australian business books.",
    logo: "/logos/myob.svg",
    connectDetail: "MYOB support is coming soon.",
    comingSoon: true,
    connections: Object.freeze([]),
  }),
  Object.freeze({
    id: "tiktok_ads" as const,
    name: "TikTok Ads",
    description: "Short-form video campaign spend and attribution.",
    logo: "/logos/tiktok.svg",
    connectDetail: "TikTok Ads support is coming soon.",
    comingSoon: true,
    connections: Object.freeze([]),
  }),
  Object.freeze({
    id: "google_analytics" as const,
    name: "Google Analytics",
    description: "Website traffic, conversion paths, and storefront funnels.",
    logo: "/logos/google-analytics.svg",
    connectDetail: "Google Analytics support is coming soon.",
    comingSoon: true,
    connections: Object.freeze([]),
  }),
  Object.freeze({
    id: "paypal" as const,
    name: "PayPal",
    description: "Checkout payments, invoices, and payout activity.",
    logo: "/logos/paypal.svg",
    connectDetail: "PayPal support is coming soon.",
    comingSoon: true,
    connections: Object.freeze([]),
  }),
  Object.freeze({
    id: "afterpay" as const,
    name: "Afterpay",
    description: "Buy now, pay later orders and settlement activity.",
    logo: "/logos/afterpay.svg",
    connectDetail: "Afterpay support is coming soon.",
    comingSoon: true,
    connections: Object.freeze([]),
  }),
  Object.freeze({
    id: "tyro" as const,
    name: "Tyro",
    description: "Australian EFTPOS, in-person payments, and settlements.",
    logo: "/logos/tyro.png",
    connectDetail: "Tyro support is coming soon.",
    comingSoon: true,
    connections: Object.freeze([]),
  }),
  Object.freeze({
    id: "klaviyo" as const,
    name: "Klaviyo",
    description: "Email and SMS campaigns, flows, and attributed revenue.",
    logo: "/logos/klaviyo.png",
    connectDetail: "Klaviyo support is coming soon.",
    comingSoon: true,
    connections: Object.freeze([]),
  }),
  Object.freeze({
    id: "woocommerce" as const,
    name: "WooCommerce",
    description: "WordPress storefront orders, products, and customers.",
    logo: "/logos/woocommerce.svg",
    connectDetail: "WooCommerce support is coming soon.",
    comingSoon: true,
    connections: Object.freeze([]),
  }),
  Object.freeze({
    id: "servicem8" as const,
    name: "ServiceM8",
    description: "Tradie jobs, scheduling, quotes, and field invoices.",
    logo: "/logos/servicem8.png",
    connectDetail: "ServiceM8 support is coming soon.",
    comingSoon: true,
    connections: Object.freeze([]),
  }),
]);

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
    Object.freeze({
      id: "square" as const,
      name: "Square",
      description: "Sales, payments, catalogue, customers, inventory, and team activity.",
      logo: "/logos/square.svg",
      connectDetail: "Connect a Square merchant account, then choose when ingestion starts.",
      connections: Object.freeze([]),
    }),
    Object.freeze({
      id: "shopify" as const,
      name: "Shopify",
      description: "Orders, products, customers, inventory, fulfilment, and payments.",
      logo: "/logos/shopify.svg",
      connectDetail: "Connect a myshopify.com store, then choose when ingestion starts.",
      connections: Object.freeze([]),
    }),
    Object.freeze({
      id: "momence" as const,
      name: "Momence",
      description: "Classes, bookings, memberships, customers, instructors, locations, and payments.",
      logo: "/logos/momence.svg",
      connectDetail: "Connect a Momence studio, then choose when ingestion starts.",
      connections: Object.freeze([]),
    }),
    ...COMING_SOON_PROVIDERS,
  ]),
  dossier: Object.freeze([]),
  blockingQuestions: Object.freeze([]),
  identityMatches: Object.freeze([]),
  oauthSelections: Object.freeze([]),
});

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
  const animating = activeSyncStates.has(state) || state === "ready_partial";

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
  ingestionState,
  popupPlacement = "below",
  layout = "card",
}: {
  accountLabel: string;
  domains: readonly DomainReadiness[];
  ingestionState?: ConnectionAccountData["ingestionState"];
  popupPlacement?: "above" | "below";
  layout?: "card" | "sidebar";
}) {
  const summary = connectionSyncSummary(domains);
  if (!connectionShowsSyncProgress(domains, ingestionState)) return null;

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
        `c:${connection.connectionId}:${connection.auth.state}:${connection.ingestionState ?? "active"}`
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
  onIngestionStarted,
  onRetry,
}: ConnectionsWorkspaceProps) {
  const componentId = useId().replaceAll(":", "");
  const [managedConnectionId, setManagedConnectionId] = useState<string | null>(null);
  // Shopify alone needs an account identity before the redirect: its authorize
  // endpoint lives on the merchant's own shop, not on a central vendor host.
  const [shopifyShopDomain, setShopifyShopDomain] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  /**
   * Manual sync state. The button reports only what the request ledger actually
   * accepted: a decline (already running, reconnect needed) is surfaced as such
   * rather than shown as a success the backend never enqueued.
   */
  const [syncStates, setSyncStates] = useState<Readonly<Record<string, ManualSyncState>>>({});
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
  const managedSyncState = managedConnectionId
    ? syncStates[managedConnectionId] ?? { status: "idle" as const }
    : { status: "idle" as const };

  const requestManualSync = useCallback(async (
    connectionId: string,
    initialStart = false,
    providerId?: ConnectionProviderId,
  ) => {
    setSyncStates((current) => ({
      ...current,
      [connectionId]: { status: "requesting" },
    }));
    try {
      const response = await fetch(
        initialStart && providerId !== "shopify"
          ? "/api/connections/start-ingestion"
          : "/api/connections/sync",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        accepted?: boolean;
        syncRunId?: string;
        message?: string;
        error?: string;
      };
      if (response.ok && payload.accepted && payload.syncRunId) {
        setSyncStates((current) => ({
          ...current,
          [connectionId]: { status: "accepted", syncRunId: payload.syncRunId! },
        }));
        onIngestionStarted?.();
        return;
      }
      setSyncStates((current) => ({
        ...current,
        [connectionId]: {
          status: "declined",
          message: payload.message ?? payload.error ?? (
            initialStart ? "Could not start ingestion." : "Could not start the sync."
          ),
        },
      }));
    } catch {
      setSyncStates((current) => ({
        ...current,
        [connectionId]: { status: "declined", message: "Could not reach the server." },
      }));
    }
  }, [onIngestionStarted]);

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

  const connectedProviders = data.providers.filter((provider) => provider.connections.length > 0);
  const notConnectedProviders = data.providers.filter((provider) => provider.connections.length === 0);

  const renderProviderGroup = (provider: ConnectionProviderData) => {
    const comingSoon = Boolean(provider.comingSoon);
    const selectionInProgress = !comingSoon && (data.oauthSelections?.some(
      (selection) => selection.provider === provider.id,
    ) ?? false);

    return (
      <section
        className={styles.connectionsProviderGroup}
        key={provider.id}
        role="listitem"
        aria-label={`${provider.name} connections`}
      >
        <div role="list" aria-label={`${provider.name} accounts`}>
          {provider.connections.length === 0 ? (
            <article
              className={styles.connectionsProviderRow}
              role="listitem"
              data-coming-soon={comingSoon || undefined}
            >
              <div className={styles.connectionsProviderMain}>
                <div className={styles.connectionsProviderIdentity}>
                  <ProviderLogo provider={provider} />
                  <div className={styles.connectionsProviderCopy}>
                    <div className={styles.connectionsProviderTitleRow}>
                      <h3>{provider.name}</h3>
                      <span
                        className={styles.connectionsAuthStatus}
                        data-auth-state={comingSoon ? "coming_soon" : "not_connected"}
                      >
                        <i aria-hidden="true" />
                        {comingSoon ? "Coming soon" : "Not connected"}
                      </span>
                    </div>
                  </div>
                </div>
                <div className={styles.connectionsProviderActions}>
                  {provider.id === "shopify" && !comingSoon ? (
                    <input
                      className={styles.connectionsShopDomainInput}
                      type="text"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="your-store.myshopify.com"
                      aria-label="Shopify store domain"
                      value={shopifyShopDomain}
                      disabled={!mutationsEnabled || !onConnect}
                      onChange={(event) => setShopifyShopDomain(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || !shopifyShopDomain.trim()) return;
                        event.preventDefault();
                        onConnect?.(provider.id, shopifyShopDomain);
                      }}
                    />
                  ) : null}
                  <button
                    className={styles.connectionsProviderActionPrimary}
                    type="button"
                    aria-busy={selectionInProgress}
                    disabled={
                      comingSoon
                      || selectionInProgress
                      || !mutationsEnabled
                      || !onConnect
                      // Shopify cannot start without a shop; disabling beats a
                      // redirect that only fails once it reaches the worker.
                      || (provider.id === "shopify" && !shopifyShopDomain.trim())
                    }
                    title={
                      comingSoon
                        ? `${provider.name} support is coming soon.`
                        : provider.id === "shopify" && !shopifyShopDomain.trim()
                          ? "Enter your myshopify.com store domain first."
                          : disabledActionTitle
                    }
                    onClick={() => {
                      if (comingSoon) return;
                      onConnect?.(
                        provider.id,
                        provider.id === "shopify" ? shopifyShopDomain : undefined,
                      );
                    }}
                  >
                    {comingSoon
                      ? "Coming soon"
                      : selectionInProgress
                        ? "Choosing account…"
                        : "Connect"}
                  </button>
                </div>
              </div>
            </article>
          ) : (
            provider.connections.map((connection) => {
              const authorizing = connection.auth.state === "authorizing";
              const accountLabel = connection.auth.accountName || provider.name;
              const connectionSyncState = syncStates[connection.connectionId] ?? { status: "idle" as const };
              const showManualStart = connection.manualIngestionStartRequired === true;
              const showSyncProgress = connectionShowsSyncProgress(
                connection.domains,
                connection.ingestionState,
              );
              const cardStatus = connectionCardStatus(connection);
              return (
                <article
                  className={styles.connectionsProviderRow}
                  key={connection.connectionId}
                  role="listitem"
                  data-connection-id={connection.connectionId}
                  data-ingestion-state={connection.ingestionState}
                  data-has-sync={showSyncProgress || undefined}
                >
                  <div className={styles.connectionsProviderMain}>
                    <div className={styles.connectionsProviderIdentity}>
                      <ProviderLogo provider={provider} />
                      <div className={styles.connectionsProviderCopy}>
                        <div className={styles.connectionsProviderTitleRow}>
                          <h3>{provider.name}</h3>
                          <span
                            className={styles.connectionsAuthStatus}
                            data-auth-state={cardStatus.authState}
                          >
                            <i aria-hidden="true" />
                            {cardStatus.label}
                          </span>
                        </div>
                        {cardStatus.detail ? <small>{cardStatus.detail}</small> : null}
                      </div>
                    </div>
                    {connection.ingestionState === "awaiting_manual_start" ? (
                      <p className={styles.connectionsIngestionReady} role="status">
                        Connected. No data has been imported yet.
                      </p>
                    ) : (
                      <ConnectionSyncProgress
                        accountLabel={accountLabel}
                        domains={connection.domains}
                        ingestionState={connection.ingestionState}
                      />
                    )}
                    <div className={styles.connectionsProviderActions}>
                      {showManualStart ? (
                        <>
                          <button
                            className={`${styles.connectionsProviderActionPrimary} ${styles.connectionsStartIngestionAction}`}
                            type="button"
                            disabled={
                              !mutationsEnabled
                              || connectionSyncState.status === "requesting"
                              || connectionSyncState.status === "accepted"
                            }
                            aria-busy={connectionSyncState.status === "requesting"}
                            title={disabledActionTitle ?? `Start ingestion for ${accountLabel}.`}
                            onClick={() => void requestManualSync(
                              connection.connectionId,
                              true,
                              provider.id,
                            )}
                          >
                            {connectionSyncState.status === "requesting"
                              ? "Starting…"
                              : connectionSyncState.status === "accepted"
                                ? "Ingestion queued"
                                : "Start ingestion"}
                          </button>
                          {connectionSyncState.status === "declined" ? (
                            <small className={styles.connectionsProviderActionFeedback} role="alert">
                              {connectionSyncState.message}
                            </small>
                          ) : null}
                        </>
                      ) : null}
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
      </section>
    );
  };

  return (
    <section className={styles.connectionsDataWorkspace} aria-labelledby={`${componentId}-title`}>
      <div className={styles.connectionsDataHeader}>
        <div>
          <h2 id={`${componentId}-title`}>Connections</h2>
          <p>The systems behind every answer.</p>
        </div>
      </div>

      {status.kind === "error" ? (
        <div className={styles.connectionsNotice} data-kind="error" role="status">
          <span aria-hidden="true">✦</span>
          <p>
            <strong>Connection status unavailable</strong>
            {status.message ? ` · ${status.message}` : ""}
          </p>
          {onRetry ? (
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

          {connectedProviders.length > 0 ? (
            <section
              className={styles.connectionsAppsSection}
              aria-labelledby={`${componentId}-connected-title`}
            >
              <h3
                className={styles.connectionsAppsSectionTitle}
                id={`${componentId}-connected-title`}
              >
                Connected
              </h3>
              <div className={styles.connectionsProviderList} role="list" aria-label="Connected apps">
                {connectedProviders.map(renderProviderGroup)}
              </div>
            </section>
          ) : null}

          {notConnectedProviders.length > 0 ? (
            <section
              className={styles.connectionsAppsSection}
              aria-labelledby={`${componentId}-not-connected-title`}
            >
              <h3
                className={styles.connectionsAppsSectionTitle}
                id={`${componentId}-not-connected-title`}
              >
                Not connected
              </h3>
              <div
                className={styles.connectionsProviderList}
                role="list"
                aria-label="Available apps"
              >
                {notConnectedProviders.map(renderProviderGroup)}
              </div>
            </section>
          ) : null}
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
                {/* Placeholder: renders the affordance only. Deliberately inert
                    A sync is enqueued server-side; the button reports only what the
                    request ledger accepted, never an optimistic success. */}
                <button
                  className={`${styles.connectionsProviderActionPrimary} ${
                    managedConnection.connection.manualIngestionStartRequired
                      ? styles.connectionsStartIngestionAction
                      : ""
                  }`}
                  type="button"
                  disabled={
                    !mutationsEnabled
                    || managedSyncState.status === "requesting"
                    || managedSyncState.status === "accepted"
                  }
                  aria-busy={managedSyncState.status === "requesting"}
                  title={
                    managedSyncState.status === "requesting"
                      ? "Starting the sync."
                      : managedConnection.connection.manualIngestionStartRequired
                        ? `Start ingestion for ${managedConnection.connection.auth.accountName || managedConnection.provider.name}.`
                        : "Fetch the latest data from this integration."
                  }
                  onClick={() => void requestManualSync(
                    managedConnection.connection.connectionId,
                    managedConnection.connection.manualIngestionStartRequired === true,
                    managedConnection.provider.id,
                  )}
                >
                  {managedSyncState.status === "requesting"
                    ? "Starting…"
                    : managedSyncState.status === "accepted"
                      ? "Ingestion queued"
                      : managedConnection.connection.manualIngestionStartRequired
                        ? "Start ingestion"
                        : "Sync now"}
                </button>
                {managedSyncState.status === "accepted" ? (
                  <small role="status">
                    Sync queued. Data appears as each domain becomes ready.
                  </small>
                ) : null}
                {managedSyncState.status === "declined" ? (
                  <small role="alert">{managedSyncState.message}</small>
                ) : null}
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
