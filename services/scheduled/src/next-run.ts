/**
 * Timezone-aware "next occurrence" arithmetic for scheduled reports, with no
 * date library: the local wall clock in an IANA zone comes from
 * Intl.DateTimeFormat, and a local wall time is turned back into an instant
 * by probing the zone's UTC offset at the guessed instant (twice, so a run
 * on a daylight-saving boundary lands on the right side of the change).
 *
 * Both the web tier (when a schedule is created or edited) and the bridge
 * scheduler (after each claimed run) call the same function, so the two
 * never disagree about when a schedule fires next.
 */
import {
  isValidTimezone,
  normaliseScheduleDays,
  TIME_OF_DAY_PATTERN,
  type ScheduleDay,
  type ScheduleSpec,
} from "./contracts.js";

/** JS getUTCDay() convention: Sunday is 0. */
const DAY_INDEX: Readonly<Record<ScheduleDay, number>> = Object.freeze({
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
});

export type ZonedParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday, in the zone's local calendar. */
  weekday: number;
}>;

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

/** The local wall clock of an instant in a zone. Throws on an unknown zone. */
export function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts = formatterFor(timezone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(read("hour"));
  return Object.freeze({
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    // Some engines still print 24 for midnight under h23; normalise.
    hour: hour === 24 ? 0 : hour,
    minute: Number(read("minute")),
    second: Number(read("second")),
    weekday: Math.max(0, WEEKDAY_NAMES.indexOf(read("weekday"))),
  });
}

/** The zone's UTC offset at an instant, in milliseconds (east positive). */
export function zonedOffsetMs(date: Date, timezone: string): number {
  const local = zonedParts(date, timezone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  // Drop the sub-second part of the instant so the comparison is clock-aligned.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant at which a zone's wall clock reads the given local time.
 * Across a spring-forward gap (a local time that never happens) the result
 * is the instant just after the gap; across a fall-back overlap the earlier
 * instant is chosen, which is the first time the clock shows that reading.
 */
export function zonedTimeToUtc(
  local: Readonly<{ year: number; month: number; day: number; hour: number; minute: number }>,
  timezone: string,
): Date {
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
  const firstOffset = zonedOffsetMs(new Date(asUtc), timezone);
  let candidate = asUtc - firstOffset;
  const secondOffset = zonedOffsetMs(new Date(candidate), timezone);
  if (secondOffset !== firstOffset) {
    const alternative = asUtc - secondOffset;
    const alternativeParts = zonedParts(new Date(alternative), timezone);
    const alternativeMatches = alternativeParts.hour === local.hour && alternativeParts.minute === local.minute;
    const candidateParts = zonedParts(new Date(candidate), timezone);
    const candidateMatches = candidateParts.hour === local.hour && candidateParts.minute === local.minute;
    if (alternativeMatches && (!candidateMatches || alternative < candidate)) candidate = alternative;
    else if (!candidateMatches && !alternativeMatches) candidate = Math.max(candidate, alternative);
  }
  return new Date(candidate);
}

export function parseTimeOfDay(timeOfDay: string): Readonly<{ hour: number; minute: number }> | null {
  if (!TIME_OF_DAY_PATTERN.test(timeOfDay)) return null;
  const [hour, minute] = timeOfDay.split(":").map(Number) as [number, number];
  return Object.freeze({ hour, minute });
}

/**
 * The first instant strictly after `after` at which the schedule fires:
 * the next allowed weekday (in the schedule's zone) at its local time of
 * day. Null when the spec is invalid.
 */
export function nextScheduledRunAt(spec: ScheduleSpec, after: Date): Date | null {
  const time = parseTimeOfDay(spec.timeOfDay);
  const days = normaliseScheduleDays(spec.days);
  if (!time || days.length === 0 || !isValidTimezone(spec.timezone)) return null;
  const allowed = new Set(days.map((day) => DAY_INDEX[day]));
  const local = zonedParts(after, spec.timezone);
  for (let offset = 0; offset <= 8; offset += 1) {
    // Pure calendar arithmetic on the local date; UTC here is just a
    // convenient day counter that handles month and year rollover.
    const dayCounter = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    if (!allowed.has(dayCounter.getUTCDay())) continue;
    const candidate = zonedTimeToUtc({
      year: dayCounter.getUTCFullYear(),
      month: dayCounter.getUTCMonth() + 1,
      day: dayCounter.getUTCDate(),
      hour: time.hour,
      minute: time.minute,
    }, spec.timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return null;
}

/**
 * Formats an instant on the schedule's own clock for the owner: "Tue 2 Sep,
 * 9:00 am". Used by the web tier for "Next run" copy.
 */
export function formatInZone(date: Date, timezone: string, locale = "en-AU"): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
