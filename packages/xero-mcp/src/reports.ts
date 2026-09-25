const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MAX_REPORT_DAYS = 366;

export function melbourneToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function australianFinancialYearStart(today = melbourneToday()): string {
  const match = ISO_DATE.exec(today);
  if (!match) return `${new Date().getUTCFullYear()}-07-01`;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month >= 7 ? `${year}-07-01` : `${year - 1}-07-01`;
}

export function xeroToolTextFailed(text: string): boolean {
  return /error listing|unexpected error occurred while communicating with xero|failed to fetch/iu.test(text);
}

function parseIso(value: unknown): string | undefined {
  return typeof value === "string" && ISO_DATE.test(value) ? value : undefined;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function financialYearToDateArgs(now = new Date()): Readonly<{
  fromDate: string;
  toDate: string;
}> {
  const toDate = melbourneToday(now);
  return { fromDate: australianFinancialYearStart(toDate), toDate };
}

/** Clamp official P&L args to a window Xero will actually serve. */
export function normaliseProfitAndLossArgs(
  args: Record<string, unknown>,
  now = new Date(),
): Readonly<{ arguments: Record<string, unknown>; adjusted: boolean; reason?: string }> {
  const today = melbourneToday(now);
  const fyStart = australianFinancialYearStart(today);
  let fromDate = parseIso(args.fromDate);
  let toDate = parseIso(args.toDate) ?? today;
  let adjusted = false;
  let reason: string | undefined;

  if (!fromDate) {
    fromDate = fyStart;
    adjusted = true;
    reason = `Set fromDate to the current Australian financial year start ${fyStart}.`;
  }
  if (fromDate > toDate) {
    fromDate = fyStart;
    toDate = today;
    adjusted = true;
    reason = `Reset an inverted date range to ${fyStart} through ${today}.`;
  } else if (daysBetween(fromDate, toDate) > MAX_REPORT_DAYS) {
    fromDate = fyStart;
    toDate = today;
    adjusted = true;
    reason = `Xero rejects P&L windows longer than a year. Used ${fyStart} through ${today}.`;
  }

  // Keep the caller's presentation options (periods, timeframe, paymentsOnly,
  // standardLayout); only the window is clamped. Dropping them made every
  // "monthly split" or "cash basis" P&L silently come back as a single accrual
  // period.
  const passthrough: Record<string, unknown> = {};
  for (const key of ["periods", "timeframe", "standardLayout", "paymentsOnly"] as const) {
    if (args[key] !== undefined && args[key] !== null) passthrough[key] = args[key];
  }
  return {
    arguments: {
      ...passthrough,
      fromDate,
      toDate,
    },
    adjusted,
    reason,
  };
}
