/**
 * Calendar helpers for the alert triggers. Everything is a local calendar
 * date in the tenant's zone written as YYYY-MM-DD; Cube returns local
 * timestamps without an offset (the session zone is pinned), so the first
 * ten characters of a Cube time value are the same kind of date.
 */

export type IsoDate = string;

const DAY_MS = 86_400_000;

function partsIn(date: Date, timezone: string): Readonly<{ year: number; month: number; day: number }> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: read("year"), month: read("month"), day: read("day") };
}

/** The local calendar date of an instant. */
export function localDate(date: Date, timezone: string): IsoDate {
  const { year, month, day } = partsIn(date, timezone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

/** The date part of a Cube time value ("2026-08-27T12:32:39.000" → "2026-08-27"). */
export function cubeDate(value: unknown): IsoDate | null {
  if (typeof value !== "string" || value.length < 10) return null;
  const candidate = value.slice(0, 10);
  return isIsoDate(candidate) ? candidate : null;
}

function utcOf(date: IsoDate): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(utcOf(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((utcOf(to) - utcOf(from)) / DAY_MS);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: IsoDate): number {
  const day = new Date(utcOf(date)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The Monday on or before the date. */
export function startOfWeek(date: IsoDate): IsoDate {
  return addDays(date, 1 - isoWeekday(date));
}

export function monthKey(date: IsoDate): string {
  return date.slice(0, 7);
}

export function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  const [year, month] = date.split("-").map(Number) as [number, number];
  const total = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function weekdayName(date: IsoDate): string {
  return WEEKDAY_NAMES[isoWeekday(date) - 1]!;
}

/** "2026-08-27" → "Thu 27 Aug". */
export function formatDay(date: IsoDate): string {
  const [, month, day] = date.split("-").map(Number) as [number, number, number];
  return `${weekdayName(date).slice(0, 3)} ${day} ${MONTH_NAMES[month - 1]}`;
}

/** "2026-08-27" → "27 Aug 2026". */
export function formatDayWithYear(date: IsoDate): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/** "2026-08" → "August". */
export function monthName(key: string): string {
  const month = Number(key.slice(5, 7));
  return MONTH_LONG[month - 1] ?? key;
}

/** "$11,994" — whole dollars, the register the owner reads on a phone. */
export function money(value: number): string {
  const rounded = Math.round(Math.abs(value));
  const formatted = rounded.toLocaleString("en-AU");
  return `${value < 0 ? "-" : ""}$${formatted}`;
}

export function percent(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`;
}

export function numberOf(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value);
}

/** Rounds a plural: "1 bike" / "3 bikes". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString("en-AU")} ${count === 1 ? singular : pluralForm}`;
}
