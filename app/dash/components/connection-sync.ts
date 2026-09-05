import type {
  AuthHealthState,
  ConnectionAccountData,
  DomainReadiness,
  ReadinessState,
} from "./ConnectionsWorkspace";

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

export const activeSyncStates = new Set<ReadinessState>([
  "syncing",
  "transforming",
  "validating",
]);

export function clampProgress(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function connectionSyncSummary(domains: readonly DomainReadiness[]) {
  if (domains.length === 0) {
    return { progress: undefined as number | undefined, state: "not_started" as ReadinessState };
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
    ?? "not_started";

  return { progress, state };
}

export function workspaceSyncIsActive(domains: readonly DomainReadiness[]): boolean {
  return domains.some(
    (domain) => activeSyncStates.has(domain.state) || domain.state === "ready_partial",
  );
}

export function connectionShowsSyncProgress(
  domains: readonly DomainReadiness[],
  ingestionState?: ConnectionAccountData["ingestionState"],
): boolean {
  if (ingestionState === "awaiting_manual_start" || ingestionState === "inactive") {
    return false;
  }
  return workspaceSyncIsActive(domains);
}

export function connectionIngestionIsPending(
  ingestionState?: ConnectionAccountData["ingestionState"],
  domains: readonly DomainReadiness[] = [],
): boolean {
  if (ingestionState !== "queued" && ingestionState !== "running") return false;
  return domains.length === 0 || workspaceSyncIsActive(domains);
}

function sentenceCase(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function connectionCardStatus(connection: ConnectionAccountData): {
  authState: AuthHealthState;
  label: string;
  detail?: string;
} {
  const summary = connectionSyncSummary(connection.domains);
  const accountName = connection.auth.accountName?.trim() || undefined;
  const worst = connection.domains.find((domain) => domain.state === summary.state);
  const worstDetail = worst?.detail ? sentenceCase(worst.detail) : undefined;

  if (connection.auth.state === "authorizing") {
    return { authState: "authorizing", label: connection.auth.label, detail: accountName };
  }
  if (connection.auth.state === "reauth_required") {
    return { authState: "reauth_required", label: connection.auth.label, detail: accountName };
  }
  if (connection.auth.state === "error") {
    return {
      authState: "error",
      label: connection.auth.label,
      detail: worstDetail && worstDetail !== connection.auth.label ? worstDetail : accountName,
    };
  }
  if (summary.state === "blocked") {
    return {
      authState: "error",
      label: "Blocked",
      detail: worstDetail || accountName,
    };
  }
  if (summary.state === "degraded") {
    return {
      authState: "reauth_required",
      label: "Needs attention",
      detail: worstDetail || accountName,
    };
  }
  if (connection.ingestionState === "queued") {
    return { authState: "authorizing", label: "Queued", detail: accountName };
  }
  if (connectionShowsSyncProgress(connection.domains, connection.ingestionState)) {
    return {
      authState: "authorizing",
      label: readinessStateLabels[summary.state],
      detail: accountName,
    };
  }
  return {
    authState: connection.auth.state,
    label: connection.auth.label,
    detail: accountName,
  };
}
