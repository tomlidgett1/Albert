import type { SingleSemanticQuery } from "./ir.js";
import { SemanticCompilerError } from "./errors.js";

export type TenantCalendarConfig = Readonly<{
  timezone: string;
  tradingDayCutoff: string;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  weekStartsOn: number;
}>;

export type ResolvedTimeRange = Readonly<{
  from: string;
  to: string;
  fromBusinessDate: string;
  toBusinessDate: string;
}>;

type DateParts = { year: number; month: number; day: number };
type WallClockParts = DateParts & { hour: number; minute: number; second: number };

export function normalizeTenantCalendar(input: Readonly<{
  timezone: string;
  tradingDayCutoff?: string;
  fiscalYearStartMonth?: number;
  fiscalYearStartDay?: number;
  weekStartsOn?: number;
}>): TenantCalendarConfig {
  assertTimezone(input.timezone);
  const tradingDayCutoff = input.tradingDayCutoff ?? "00:00";
  parseCutoff(tradingDayCutoff);
  const fiscalYearStartMonth = input.fiscalYearStartMonth ?? 7;
  const fiscalYearStartDay = input.fiscalYearStartDay ?? 1;
  const weekStartsOn = input.weekStartsOn ?? 1;
  if (!Number.isInteger(fiscalYearStartMonth) || fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) {
    throw new SemanticCompilerError("INVALID_PARAMETER", "Fiscal year start month must be between 1 and 12.");
  }
  const maxDay = daysInMonth(2000, fiscalYearStartMonth);
  if (!Number.isInteger(fiscalYearStartDay) || fiscalYearStartDay < 1 || fiscalYearStartDay > maxDay) {
    throw new SemanticCompilerError("INVALID_PARAMETER", `Fiscal year start day must be valid for month ${fiscalYearStartMonth}.`);
  }
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 1 || weekStartsOn > 7) {
    throw new SemanticCompilerError("INVALID_PARAMETER", "weekStartsOn must use ISO weekday 1 through 7.");
  }
  return { timezone: input.timezone, tradingDayCutoff, fiscalYearStartMonth, fiscalYearStartDay, weekStartsOn };
}

export function resolveTenantTimeRange(
  range: SingleSemanticQuery["time"]["range"],
  nowValue: string,
  calendarInput: TenantCalendarConfig,
): ResolvedTimeRange {
  const now = new Date(nowValue);
  if (!Number.isFinite(now.getTime())) throw new SemanticCompilerError("INVALID_IR", `Invalid trusted clock value ${nowValue}.`);
  const calendar = normalizeTenantCalendar(calendarInput);
  if (range.type === "absolute") {
    const from = new Date(range.from);
    const to = new Date(range.to);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
      throw new SemanticCompilerError("INVALID_IR", "Absolute time range must end after it starts.");
    }
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      fromBusinessDate: formatDate(businessDateForInstant(from, calendar)),
      toBusinessDate: formatDate(businessDateForInstant(to, calendar)),
    };
  }

  const currentBusinessDate = businessDateForInstant(now, calendar);
  let startDate = currentBusinessDate;
  if (range.type === "last_n_days") startDate = addDays(currentBusinessDate, -(range.days - 1));
  if (range.type === "month_to_date") startDate = { year: currentBusinessDate.year, month: currentBusinessDate.month, day: 1 };
  if (range.type === "quarter_to_date") startDate = fiscalQuarterStart(currentBusinessDate, calendar);
  if (range.type === "year_to_date") startDate = fiscalYearStart(currentBusinessDate, calendar);
  const endDate = addDays(currentBusinessDate, 1);
  return rangeFromBusinessDates(startDate, endDate, calendar);
}

export function resolveComparisonTimeRange(
  current: ResolvedTimeRange,
  compare: Exclude<SingleSemanticQuery["time"]["compare"], "none">,
  calendarInput: TenantCalendarConfig,
): ResolvedTimeRange {
  const calendar = normalizeTenantCalendar(calendarInput);
  const currentStart = parseDate(current.fromBusinessDate);
  const currentEnd = parseDate(current.toBusinessDate);
  const shift = compare === "same_period_prior_week"
    ? (value: DateParts) => addDays(value, -7)
    : compare === "same_period_prior_month"
      ? (value: DateParts) => addMonths(value, -1)
      : (value: DateParts) => addYears(value, -1);
  // "Same period" has to mean the same number of days. Shifting both endpoints
  // independently does not: months are unequal and addMonths clamps a month
  // end, so 29 Jul - 5 Aug (7 days) became 29 Jun - 5 Jul (6 days) and
  // 1 - 31 Mar became 1 - 28 Feb. The change percentage was then computed
  // against a shorter window and reported as a like-for-like comparison.
  // Anchor the shifted start and carry the original length.
  const lengthMs = compareDates(currentEnd, currentStart);
  const shiftedStart = shift(currentStart);
  const shiftedEnd = addDays(shiftedStart, Math.round(lengthMs / 86_400_000));
  return rangeFromBusinessDates(shiftedStart, shiftedEnd, calendar);
}

export function shiftRangeStartByDays(
  range: ResolvedTimeRange,
  days: number,
  calendarInput: TenantCalendarConfig,
): ResolvedTimeRange {
  if (!Number.isInteger(days) || days < 1 || days > 3660) {
    throw new SemanticCompilerError("INVALID_PARAMETER", "Tenant window days must be an integer between 1 and 3660.");
  }
  const calendar = normalizeTenantCalendar(calendarInput);
  return rangeFromBusinessDates(addDays(parseDate(range.toBusinessDate), -days), parseDate(range.toBusinessDate), calendar);
}

function rangeFromBusinessDates(start: DateParts, end: DateParts, calendar: TenantCalendarConfig): ResolvedTimeRange {
  const cutoff = parseCutoff(calendar.tradingDayCutoff);
  const from = zonedWallClockToUtc({ ...start, hour: cutoff.hour, minute: cutoff.minute, second: 0 }, calendar.timezone);
  const to = zonedWallClockToUtc({ ...end, hour: cutoff.hour, minute: cutoff.minute, second: 0 }, calendar.timezone);
  return { from: from.toISOString(), to: to.toISOString(), fromBusinessDate: formatDate(start), toBusinessDate: formatDate(end) };
}

function businessDateForInstant(instant: Date, calendar: TenantCalendarConfig): DateParts {
  const local = zonedParts(instant, calendar.timezone);
  const cutoff = parseCutoff(calendar.tradingDayCutoff);
  const beforeCutoff = local.hour * 60 + local.minute < cutoff.hour * 60 + cutoff.minute;
  const date = { year: local.year, month: local.month, day: local.day };
  return beforeCutoff ? addDays(date, -1) : date;
}

function fiscalYearStart(date: DateParts, calendar: TenantCalendarConfig): DateParts {
  const candidate = safeDate(date.year, calendar.fiscalYearStartMonth, calendar.fiscalYearStartDay);
  return compareDates(date, candidate) >= 0
    ? candidate
    : safeDate(date.year - 1, calendar.fiscalYearStartMonth, calendar.fiscalYearStartDay);
}

function fiscalQuarterStart(date: DateParts, calendar: TenantCalendarConfig): DateParts {
  const start = fiscalYearStart(date, calendar);
  let quarterStart = start;
  for (const months of [3,6,9]) {
    const candidate = addMonths(start, months);
    if (compareDates(candidate,date) > 0) break;
    quarterStart = candidate;
  }
  return quarterStart;
}

function zonedWallClockToUtc(target: WallClockParts, timezone: string): Date {
  const targetEpoch = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  let candidateEpoch = targetEpoch;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const observed = zonedParts(new Date(candidateEpoch), timezone);
    const observedEpoch = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const delta = targetEpoch - observedEpoch;
    candidateEpoch += delta;
    if (delta === 0) break;
  }
  const candidate = new Date(candidateEpoch);
  const observed = zonedParts(candidate, timezone);
  if (
    observed.year !== target.year || observed.month !== target.month || observed.day !== target.day ||
    observed.hour !== target.hour || observed.minute !== target.minute
  ) {
    throw new SemanticCompilerError("INVALID_PARAMETER", `Trading-day cutoff ${formatWall(target)} does not exist in ${timezone} because of a timezone transition.`);
  }
  return candidate;
}

function zonedParts(date: Date, timezone: string): WallClockParts {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
  } catch {
    throw new SemanticCompilerError("INVALID_PARAMETER", `Invalid tenant timezone ${timezone}.`);
  }
}

function assertTimezone(timezone: string): void { zonedParts(new Date(0), timezone); }
function parseCutoff(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new SemanticCompilerError("INVALID_PARAMETER", `Invalid trading-day cutoff ${value}; expected HH:mm.`);
  const hour = Number(match[1]); const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new SemanticCompilerError("INVALID_PARAMETER", `Invalid trading-day cutoff ${value}.`);
  return { hour, minute };
}
function parseDate(value: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new SemanticCompilerError("INVALID_IR", `Invalid business date ${value}.`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}
function addDays(value: DateParts, days: number): DateParts { const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days)); return utcParts(date); }
function addMonths(value: DateParts, months: number): DateParts {
  const monthIndex = value.year * 12 + value.month - 1 + months;
  const year = Math.floor(monthIndex / 12); const month = ((monthIndex % 12) + 12) % 12 + 1;
  return safeDate(year, month, value.day);
}
function addYears(value: DateParts, years: number): DateParts { return safeDate(value.year + years, value.month, value.day); }
function safeDate(year: number, month: number, day: number): DateParts { return { year, month, day: Math.min(day, daysInMonth(year, month)) }; }
function daysInMonth(year: number, month: number): number { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function utcParts(value: Date): DateParts { return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }; }
function compareDates(left: DateParts, right: DateParts): number { return Date.UTC(left.year,left.month-1,left.day)-Date.UTC(right.year,right.month-1,right.day); }
function formatDate(value: DateParts): string { return `${value.year}-${pad(value.month)}-${pad(value.day)}`; }
function formatWall(value: WallClockParts): string { return `${formatDate(value)} ${pad(value.hour)}:${pad(value.minute)}`; }
function pad(value: number): string { return String(value).padStart(2, "0"); }
