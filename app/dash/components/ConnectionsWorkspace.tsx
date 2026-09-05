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
  | "servicem8"
  | "fivetran-xero"
  | "fivetran-lightspeed"
  | "fivetran-deputy"
  | "fivetran-stripe";
export type MatchDecision = "proposed" | "accepted" | "rejected";
export type ConnectableProviderId =
  | "lightspeed" | "lightspeed-x" | "xero" | "deputy" | "square"
  | "shopify" | "stripe" | "momence" | "meta-ads" | "google-ads"
  | "fivetran-xero" | "fivetran-lightspeed" | "fivetran-deputy" | "fivetran-stripe";

/**
 * Providers whose ingestion Fivetran runs. `handoff` describes the hosted
 * Connect Card the user is sent to (null when Albert authorises without a
 * card, as it does for Deputy).
 */
export type FivetranHandoffCopy = Readonly<{
  steps: ReadonlyArray<readonly [string, string, string]>;
  note: string;
}>;
export const FIVETRAN_PROVIDERS: Readonly<Record<
  "fivetran-xero" | "fivetran-lightspeed" | "fivetran-deputy" | "fivetran-stripe",
  Readonly<{ sourceName: string; dataNoun: string; handoff: FivetranHandoffCopy | null }>
>> = Object.freeze({
  // Xero: Albert takes the grant itself (single Xero consent) and hands it to
  // Albert's Fivetran SDK connector — no hosted card, so no hand-off dialog.
  "fivetran-xero": Object.freeze({
    sourceName: "Xero",
    dataNoun: "accounting data",
    handoff: null,
  }),
  // Lightspeed R-Series: same shape as Xero — Albert's own Lightspeed consent,
  // then Albert's Fivetran SDK connector lands every ls_* table. No card.
  "fivetran-lightspeed": Object.freeze({
    sourceName: "Lightspeed",
    dataNoun: "sales and inventory data",
    handoff: null,
  }),
  "fivetran-deputy": Object.freeze({
    sourceName: "Deputy",
    dataNoun: "rosters, timesheets, and leave",
    handoff: null,
  }),
  "fivetran-stripe": Object.freeze({
    sourceName: "Stripe",
    dataNoun: "charges, invoices, subscriptions, and payouts",
    handoff: null,
  }),
} as const);
export type FivetranProviderId = keyof typeof FIVETRAN_PROVIDERS;
export function isFivetranProviderId(value: string): value is FivetranProviderId {
  return Object.prototype.hasOwnProperty.call(FIVETRAN_PROVIDERS, value);
}

/** Native ingest cards superseded by Fivetran. Hidden unless a live connection remains. */
export const SUPERSEDED_NATIVE_PROVIDER_IDS = new Set<ConnectionProviderId>([
  "lightspeed",
  "xero",
  "deputy",
  "stripe",
]);
export function isVisibleConnectionProvider(
  provider: Pick<ConnectionProviderData, "id" | "connections">,
): boolean {
  return !SUPERSEDED_NATIVE_PROVIDER_IDS.has(provider.id) || provider.connections.length > 0;
}

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
      id: "fivetran-xero" as const,
      name: "Xero (Fivetran)",
      description: "Full Xero ingest through Fivetran, into a tenant-isolated native schema.",
      logo: "/logos/xero.svg",
      connectDetail: "Approve Xero once. Albert hands the grant to Fivetran and the full sync — accounting, payroll, reports — starts in the background.",
      connections: Object.freeze([]),
    }),
    Object.freeze({
      id: "fivetran-lightspeed" as const,
      name: "Lightspeed (Fivetran)",
      description: "Full Lightspeed Retail R-Series ingest through Fivetran, into a tenant-isolated native schema.",
      logo: "/logos/lightspeed.png",
      connectDetail: "Approve Lightspeed through Fivetran. Albert then starts the Fivetran sync into a tenant-isolated native schema.",
      connections: Object.freeze([]),
    }),
    Object.freeze({
      id: "fivetran-deputy" as const,
      name: "Deputy (Fivetran)",
      description: "Full Deputy ingest through Fivetran, into a tenant-isolated native schema.",
      logo: "/logos/deputy.png",
      connectDetail: "Approve Deputy. Albert hands the grant to Fivetran and the sync starts in the background.",
      connections: Object.freeze([]),
    }),
    Object.freeze({
      id: "fivetran-stripe" as const,
      name: "Stripe (Fivetran)",
      description: "Full Stripe ingest through Fivetran's official schema, into a tenant-isolated native schema.",
      logo: "/logos/stripe.svg",
      connectDetail: "Approve Stripe. Albert hands the grant to Fivetran and the official Stripe ERD syncs in the background.",
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
  // Fully synced: swap the bar for a quiet last-synced stamp (card layout only;
  // the sidebar keeps its compact bar). Latest domain watermark, if any.
  const latestWatermark = domains.reduce<string | null>((latest, domain) => {
    const at = domain.watermark?.at;
    if (!at || !Number.isFinite(Date.parse(at))) return latest;
    return !latest || Date.parse(at) > Date.parse(latest) ? at : latest;
  }, null);
  const complete = layout === "card" && summary.state === "ready_complete";
  const completeStamp = relativeTimeLabel(latestWatermark);

  return (
    <div
      className={layout === "sidebar" ? styles.sidebarSyncProgress : styles.connectionsCardSync}
      data-popup-placement={popupPlacement}
    >
      {complete ? (
        <span className={styles.fivetranSyncedStamp} role="status">
          {completeStamp ? `Synced ${completeStamp}` : "Up to date"}
        </span>
      ) : (
        <div className={layout === "sidebar" ? styles.sidebarSyncBar : styles.connectionsCardSyncBar}>
          <ProgressBar
            value={summary.progress}
            state={summary.state}
            size="fat"
            label={`${accountLabel} sync progress`}
          />
        </div>
      )}

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

/* ------------------------------------------------------------------------ */
/* Fivetran-managed connections: live readout from Fivetran + the destination */
/* ------------------------------------------------------------------------ */

export type FivetranSyncPhase =
  | "historical"
  | "incremental"
  | "up_to_date"
  | "scheduled"
  | "paused"
  | "failed"
  | "broken";

export type FivetranSyncStatusData = Readonly<{
  connectionId: string;
  phase: FivetranSyncPhase;
  progress?: number;
  paused: boolean;
  succeededAt: string | null;
  failedAt: string | null;
  warnings: readonly string[];
  schemaLoaded: boolean;
  enabledTables: number;
  landedTables: number;
  totalRows: number;
  tables: ReadonlyArray<Readonly<{ table: string; rows: number }>>;
  checkedAt: string;
}>;

export const fivetranPhaseCopy: Readonly<Record<FivetranSyncPhase, { label: string; state: ReadinessState }>> =
  Object.freeze({
    historical: { label: "Loading history", state: "syncing" },
    incremental: { label: "Syncing changes", state: "syncing" },
    up_to_date: { label: "Up to date", state: "ready_complete" },
    scheduled: { label: "Waiting for first sync", state: "not_started" },
    paused: { label: "Paused", state: "not_started" },
    failed: { label: "Last sync failed", state: "degraded" },
    broken: { label: "Needs re-authorisation", state: "blocked" },
  });

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const fullNumber = new Intl.NumberFormat("en");

export function formatFivetranTableName(table: string): string {
  return table.replace(/_/g, " ");
}

export function relativeTimeLabel(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

/**
 * Poll cadence tracks how fast the truth changes: every 15 s while Fivetran
 * is loading or syncing, every 2 min once it is idle, and never while the tab
 * is hidden. Three consecutive failures stop the poll so a broken worker does
 * not become a request storm; the last good readout stays on screen.
 */
/**
 * How often a tile asks the worker for Fivetran status. Every poll costs two
 * Fivetran API calls against the account's 500/hour limit, so only an ACTIVE
 * sync (historical load or incremental run) polls quickly; an idle
 * "scheduled" connection changes nothing until its next run and is read every
 * five minutes. Three tiles at 15 s each saturated the Fivetran API on
 * 2026-08-19 and blocked schedule changes.
 */
function fivetranPollDelay(phase: FivetranSyncPhase | null): number {
  if (phase === "historical" || phase === "incremental") return 15_000;
  if (phase === null) return 30_000;
  return 300_000;
}

export function FivetranSyncProgress({
  connectionId,
  accountLabel,
  sourceName = "the source",
}: {
  connectionId: string;
  accountLabel: string;
  sourceName?: string;
}) {
  const [status, setStatus] = useState<FivetranSyncStatusData | null>(null);
  const [failures, setFailures] = useState(0);
  const [tick, setTick] = useState(0);
  const phase = status?.phase ?? null;
  const gaveUp = failures >= 3;

  useEffect(() => {
    if (gaveUp) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        timer = window.setTimeout(() => void load(), 30_000);
        return;
      }
      try {
        const response = await fetch(
          `/api/connections/fivetran-status?connectionId=${encodeURIComponent(connectionId)}`,
          { headers: { accept: "application/json" }, cache: "no-store" },
        );
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as FivetranSyncStatusData;
        if (cancelled) return;
        setStatus(payload);
        setFailures(0);
        timer = window.setTimeout(() => void load(), fivetranPollDelay(payload.phase));
      } catch {
        if (cancelled) return;
        setFailures((count) => count + 1);
        timer = window.setTimeout(() => void load(), 30_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // `tick` deliberately NOT a dependency: it only re-renders the relative
    // time label. Including it restarted this effect (and fetched status)
    // every 30 s regardless of fivetranPollDelay.
  }, [connectionId, gaveUp]);

  // Re-render every 30 s so "4 min ago" keeps moving between polls.
  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  void tick;

  const copy = phase ? fivetranPhaseCopy[phase] : { label: "Checking…", state: "syncing" as ReadinessState };
  const determinate = typeof status?.progress === "number";
  const lastSuccess = relativeTimeLabel(status?.succeededAt ?? null);
  const visibleTables = status?.tables.filter((table) => table.rows > 0).slice(0, 7) ?? [];
  const hiddenLanded = Math.max(0, (status?.landedTables ?? 0) - visibleTables.length);

  return (
    <div
      className={styles.connectionsCardSync}
      data-popup-placement="below"
      data-fivetran-phase={phase ?? "loading"}
      data-testid="fivetran-sync-progress"
      tabIndex={0}
      aria-label={`${accountLabel} sync status: ${copy.label}`}
    >
      {phase === "up_to_date" ? (
        // Fully synced: the bar has nothing left to say. A quiet timestamp
        // reads as "done"; the hover popup keeps the detail.
        <span className={styles.fivetranSyncedStamp} role="status">
          {lastSuccess ? `Synced ${lastSuccess}` : "Up to date"}
        </span>
      ) : (
        <div className={styles.connectionsCardSyncBar}>
          <ProgressBar
            value={determinate ? status?.progress : undefined}
            state={copy.state}
            size="fat"
            label={`${accountLabel} sync progress`}
          />
        </div>
      )}

      <div className={styles.connectionsCardSyncPopup} role="tooltip">
        <div className={styles.fivetranSyncHeader}>
          <span className={styles.fivetranSyncPhase} data-state={copy.state}>
            <i aria-hidden="true" />
            {copy.label}
          </span>
          <small>
            {phase === "historical"
              ? `First full load of your ${sourceName} history`
              : lastSuccess
                ? `Last synced ${lastSuccess}`
                : phase === "scheduled"
                  ? "Fivetran will start shortly"
                  : phase === "broken"
                    ? "Choose Manage → Reconnect"
                    : ""}
          </small>
        </div>

        {status ? (
          <>
            <div className={styles.fivetranSyncStats}>
              <div>
                <strong>{fullNumber.format(status.landedTables)}</strong>
                <span>
                  {status.enabledTables > 0 && status.phase === "historical"
                    ? `of ${fullNumber.format(status.enabledTables)} tables`
                    : status.landedTables === 1 ? "table" : "tables"}
                </span>
              </div>
              <div>
                <strong title={fullNumber.format(status.totalRows)}>≈{compactNumber.format(status.totalRows)}</strong>
                <span>rows landed</span>
              </div>
              {status.phase === "historical" && determinate ? (
                <div>
                  <strong>{clampProgress(status.progress!)}%</strong>
                  <span>of tables reached</span>
                </div>
              ) : null}
            </div>

            {visibleTables.length > 0 ? (
              <ul className={styles.fivetranSyncTables}>
                {visibleTables.map((table) => (
                  <li key={table.table}>
                    <span>{formatFivetranTableName(table.table)}</span>
                    <em>{compactNumber.format(table.rows)}</em>
                  </li>
                ))}
                {hiddenLanded > 0 ? (
                  <li data-more="true">
                    <span>+{hiddenLanded} more {hiddenLanded === 1 ? "table" : "tables"}</span>
                    <em />
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className={styles.connectionsCardSyncEmpty}>
                {status.phase === "historical" || status.phase === "scheduled"
                  ? "Tables appear here as Fivetran lands them."
                  : status.phase === "broken"
                    ? `Fivetran can no longer reach ${sourceName}. Reconnect to resume.`
                    : "Nothing has landed yet."}
              </p>
            )}

            {status.warnings.length > 0 ? (
              <ul className={styles.fivetranSyncWarnings}>
                {status.warnings.slice(0, 3).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className={styles.connectionsCardSyncEmpty}>
            {gaveUp ? "Sync status is unavailable right now." : "Checking with Fivetran…"}
          </p>
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
   * Fivetran's Xero connector is authorised inside Fivetran's hosted Connect
   * Card, which Albert cannot trim below "Authorize → choose organisation →
   * Save & Test". Name those steps before the hand-off so the page that
   * follows reads as expected rather than as somewhere the user got lost.
   */
  const [fivetranHandoff, setFivetranHandoff] = useState<FivetranProviderId | null>(null);
  const fivetranHandoffContinueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!fivetranHandoff) return;
    fivetranHandoffContinueRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFivetranHandoff(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fivetranHandoff]);
  const startConnect = useCallback((providerId: ConnectionProviderId, shopDomain?: string) => {
    if (isFivetranProviderId(providerId) && FIVETRAN_PROVIDERS[providerId].handoff) {
      setFivetranHandoff(providerId);
      return;
    }
    onConnect?.(providerId, shopDomain);
  }, [onConnect]);
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

  const catalogProviders = data.providers.filter(isVisibleConnectionProvider);
  const connectedProviders = catalogProviders.filter((provider) => provider.connections.length > 0);
  const notConnectedProviders = catalogProviders.filter((provider) => provider.connections.length === 0);

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
                      <h3>
                        {isFivetranProviderId(provider.id)
                          ? FIVETRAN_PROVIDERS[provider.id].sourceName
                          : provider.name}
                      </h3>
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
                      startConnect(
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
              const showProblemStatus =
                cardStatus.authState === "reauth_required" || cardStatus.authState === "error";
              const cardName = isFivetranProviderId(provider.id)
                ? FIVETRAN_PROVIDERS[provider.id].sourceName
                : provider.name;
              const syncSlot = isFivetranProviderId(provider.id) && !authorizing ? (
                <FivetranSyncProgress
                  connectionId={connection.connectionId}
                  accountLabel={accountLabel}
                  sourceName={FIVETRAN_PROVIDERS[provider.id].sourceName}
                />
              ) : connection.ingestionState === "awaiting_manual_start" ? (
                <span className={styles.fivetranSyncedStamp} role="status">
                  Not imported yet
                </span>
              ) : (
                <ConnectionSyncProgress
                  accountLabel={accountLabel}
                  domains={connection.domains}
                  ingestionState={connection.ingestionState}
                />
              );
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
                          <h3>{cardName}</h3>
                          {showProblemStatus ? (
                            <span
                              className={styles.connectionsAuthStatus}
                              data-auth-state={cardStatus.authState}
                            >
                              <i aria-hidden="true" />
                              {cardStatus.label}
                            </span>
                          ) : syncSlot}
                        </div>
                      </div>
                    </div>
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
                        aria-busy={authorizing && !isFivetranProviderId(provider.id)}
                        disabled={
                          (authorizing && !isFivetranProviderId(provider.id)) ||
                          !mutationsEnabled ||
                          (isFivetranProviderId(provider.id) && authorizing
                            ? !onConnect
                            : !onManage && !onConnect && !onDisconnect)
                        }
                        title={disabledActionTitle}
                        onClick={() => {
                          if (isFivetranProviderId(provider.id) && authorizing) {
                            onConnect?.(provider.id);
                            return;
                          }
                          if (onManage) onManage(connection.connectionId);
                          else {
                            setManagedConnectionId(connection.connectionId);
                            setConfirmDisconnect(false);
                          }
                        }}
                      >
                        {authorizing
                          ? isFivetranProviderId(provider.id) ? "Try again" : "Authorizing…"
                          : "Manage"}
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

      {fivetranHandoff && FIVETRAN_PROVIDERS[fivetranHandoff].handoff ? (() => {
        const handoffProvider = fivetranHandoff;
        const copy = FIVETRAN_PROVIDERS[handoffProvider];
        const handoff = copy.handoff!;
        const providerData = data.providers.find((provider) => provider.id === handoffProvider)
          ?? emptyConnectionsWorkspace.providers.find((provider) => provider.id === handoffProvider)!;
        return (
          <div
            className={styles.connectionsManageBackdrop}
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setFivetranHandoff(null);
            }}
          >
            <section
              className={styles.connectionsManageDialog}
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${componentId}-fivetran-handoff-title`}
              data-testid={`${handoffProvider}-handoff`}
            >
              <button
                className={styles.connectionsManageClose}
                type="button"
                aria-label="Close"
                onClick={() => setFivetranHandoff(null)}
              >
                ×
              </button>
              <div className={styles.connectionsProviderIdentity}>
                <ProviderLogo provider={providerData} />
                <div className={styles.connectionsProviderCopy}>
                  <div className={styles.connectionsProviderTitleRow}>
                    <h3 id={`${componentId}-fivetran-handoff-title`}>Connect {copy.sourceName}</h3>
                  </div>
                  <small>Three quick steps on our secure connection page</small>
                </div>
              </div>
              <ol className={styles.connectionsHandoffSteps}>
                {handoff.steps.map(([before, emphasis, after]) => (
                  <li key={emphasis}>{before}<strong>{emphasis}</strong>{after}</li>
                ))}
              </ol>
              <p className={styles.connectionsHandoffNote}>
                {handoff.note}
                {" "}Albert only reads your {copy.dataNoun}; nothing is written back to {copy.sourceName}.
              </p>
              <div className={styles.connectionsManageActions}>
                <button
                  className={styles.connectionsProviderActionSecondary}
                  type="button"
                  onClick={() => setFivetranHandoff(null)}
                >
                  Not now
                </button>
                <button
                  className={styles.connectionsProviderActionPrimary}
                  type="button"
                  ref={fivetranHandoffContinueRef}
                  onClick={() => {
                    setFivetranHandoff(null);
                    onConnect?.(handoffProvider);
                  }}
                >
                  Continue to {copy.sourceName}
                </button>
              </div>
            </section>
          </div>
        );
      })() : null}

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
