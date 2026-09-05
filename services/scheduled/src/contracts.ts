/**
 * Scheduled reports (ADR 0131): the owner describes a recurring iMessage
 * report in plain language; Albert turns it into a schedule, runs the Omni
 * analysis at the chosen local time and texts the answer over Linq.
 *
 * Shared facts between the web surface (app/dash Scheduled tab +
 * /api/scheduled), the control-plane repository and the imessage-bridge
 * scheduler that executes runs. Pure: no I/O, no model.
 */
import { z } from "zod";

export const SCHEDULE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type ScheduleDay = (typeof SCHEDULE_DAYS)[number];

export const SCHEDULE_DAY_LABELS: Readonly<Record<ScheduleDay, string>> = Object.freeze({
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
});

export const SCHEDULE_DAY_SHORT: Readonly<Record<ScheduleDay, string>> = Object.freeze({
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
});

export const WEEKDAYS: readonly ScheduleDay[] = Object.freeze(["mon", "tue", "wed", "thu", "fri"]);
export const WEEKEND: readonly ScheduleDay[] = Object.freeze(["sat", "sun"]);

/** At most this many schedules per organisation (mirrors the 20-number enrolment cap). */
export const SCHEDULED_TASK_LIMIT = 20;
/** A due slot older than this is recorded as missed rather than sent hours late. */
export const SCHEDULED_RUN_GRACE_MS = 3 * 60 * 60_000;
/** The scheduler's default poll cadence. */
export const SCHEDULED_POLL_DEFAULT_SECONDS = 20;

export const TIME_OF_DAY_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;
export const PHONE_E164_PATTERN = /^\+[1-9][0-9]{5,14}$/u;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export const scheduleDaySchema = z.enum(SCHEDULE_DAYS);

export const scheduledRunStatuses = ["queued", "running", "sent", "failed", "missed"] as const;
export type ScheduledRunStatus = (typeof scheduledRunStatuses)[number];

export const scheduledRunSchema = z.object({
  runId: z.string().regex(ULID_PATTERN),
  taskId: z.string().regex(ULID_PATTERN),
  trigger: z.enum(["schedule", "manual"]),
  status: z.enum(scheduledRunStatuses),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  scheduledFor: z.string().nullable(),
  conversationId: z.string().nullable(),
  turnId: z.string().nullable(),
  answerState: z.string().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  bubbles: z.number().int().min(0).nullable(),
}).passthrough();

export type ScheduledRun = Readonly<{
  runId: string;
  taskId: string;
  trigger: "schedule" | "manual";
  status: ScheduledRunStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  scheduledFor: string | null;
  conversationId: string | null;
  turnId: string | null;
  answerState: string | null;
  summary: string | null;
  error: string | null;
  bubbles: number | null;
}>;

export const scheduledTaskSchema = z.object({
  taskId: z.string().regex(ULID_PATTERN),
  title: z.string().min(1).max(80),
  requestText: z.string().min(1).max(2_000),
  prompt: z.string().min(1).max(2_000),
  timeOfDay: z.string().regex(TIME_OF_DAY_PATTERN),
  days: z.array(scheduleDaySchema).min(1).max(7),
  timezone: z.string().min(1).max(80),
  phone: z.string().regex(PHONE_E164_PATTERN),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRun: scheduledRunSchema.nullish(),
  recentRuns: z.array(scheduledRunSchema).nullish(),
}).passthrough();

export type ScheduledTask = Readonly<{
  taskId: string;
  title: string;
  requestText: string;
  prompt: string;
  timeOfDay: string;
  days: readonly ScheduleDay[];
  timezone: string;
  phone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun: ScheduledRun | null;
  recentRuns: readonly ScheduledRun[];
}>;

/** The schedule half of a task: what the next-run computation needs. */
export type ScheduleSpec = Readonly<{
  timeOfDay: string;
  days: readonly ScheduleDay[];
  timezone: string;
}>;

export function toScheduledRun(raw: z.infer<typeof scheduledRunSchema>): ScheduledRun {
  return Object.freeze({
    runId: raw.runId,
    taskId: raw.taskId,
    trigger: raw.trigger,
    status: raw.status,
    requestedAt: raw.requestedAt,
    startedAt: raw.startedAt ?? null,
    finishedAt: raw.finishedAt ?? null,
    scheduledFor: raw.scheduledFor ?? null,
    conversationId: raw.conversationId ?? null,
    turnId: raw.turnId ?? null,
    answerState: raw.answerState ?? null,
    summary: raw.summary ?? null,
    error: raw.error ?? null,
    bubbles: raw.bubbles ?? null,
  });
}

export function toScheduledTask(raw: z.infer<typeof scheduledTaskSchema>): ScheduledTask {
  return Object.freeze({
    taskId: raw.taskId,
    title: raw.title,
    requestText: raw.requestText,
    prompt: raw.prompt,
    timeOfDay: raw.timeOfDay,
    days: Object.freeze(normaliseScheduleDays(raw.days)),
    timezone: raw.timezone,
    phone: raw.phone,
    enabled: raw.enabled,
    nextRunAt: raw.nextRunAt ?? null,
    lastRunAt: raw.lastRunAt ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lastRun: raw.lastRun ? toScheduledRun(raw.lastRun) : null,
    recentRuns: Object.freeze((raw.recentRuns ?? []).map(toScheduledRun)),
  });
}

/** Deduplicated, in week order (Monday first). */
export function normaliseScheduleDays(days: readonly string[]): ScheduleDay[] {
  const wanted = new Set(days);
  return SCHEDULE_DAYS.filter((day) => wanted.has(day));
}

export function isValidTimezone(timezone: string): boolean {
  if (!timezone || timezone.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** "09:00" → "9:00 am", "17:30" → "5:30 pm". */
export function formatTimeOfDay(timeOfDay: string): string {
  const match = TIME_OF_DAY_PATTERN.exec(timeOfDay);
  if (!match) return timeOfDay;
  const [hours, minutes] = timeOfDay.split(":").map(Number) as [number, number];
  const suffix = hours >= 12 ? "pm" : "am";
  const twelveHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelveHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function listInEnglish(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/** "Every day at 9:00 am", "Weekdays at 8:30 am", "Mondays at 9:00 am", "Mon, Wed and Fri at 9:00 am". */
export function describeScheduleDays(days: readonly ScheduleDay[]): string {
  const ordered = normaliseScheduleDays(days);
  if (ordered.length === 7) return "Every day";
  if (ordered.length === 5 && WEEKDAYS.every((day) => ordered.includes(day))) return "Weekdays";
  if (ordered.length === 2 && WEEKEND.every((day) => ordered.includes(day))) return "Weekends";
  if (ordered.length === 1) return `${SCHEDULE_DAY_LABELS[ordered[0]!]}s`;
  return listInEnglish(ordered.map((day) => SCHEDULE_DAY_SHORT[day]));
}

export function describeSchedule(spec: ScheduleSpec): string {
  return `${describeScheduleDays(spec.days)} at ${formatTimeOfDay(spec.timeOfDay)}`;
}

/** "+61414187820" → "+61 414 187 820"; "+16502831814" → "+1 (650) 283-1814". */
export function formatPhoneForDisplay(phone: string): string {
  if (/^\+614\d{8}$/u.test(phone)) {
    return `+61 ${phone.slice(3, 6)} ${phone.slice(6, 9)} ${phone.slice(9)}`;
  }
  if (/^\+1\d{10}$/u.test(phone)) {
    return `+1 (${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;
  }
  return phone;
}

/**
 * The message the Omni turn receives for one run. The stored prompt is the
 * owner's standing question; the framing tells the analyst this is a
 * standalone scheduled update, not a reply in a conversation.
 */
export function scheduledRunMessage(task: Readonly<{ title: string; prompt: string }>): string {
  return [
    task.prompt.trim(),
    "",
    `(Scheduled update "${task.title.trim()}": write it as a standalone text-message report. Open with the headline figures, no greeting, no questions back.)`,
  ].join("\n");
}

/** The conversation title a scheduled run is saved under. */
export function scheduledRunConversationTitle(task: Readonly<{ title: string }>): string {
  return `Scheduled · ${task.title.trim().slice(0, 60)}`;
}

/** The text sent when a scheduled run could not be produced. */
export function scheduledFailureText(task: Readonly<{ title: string }>): string {
  return `Albert couldn't put together "${task.title.trim()}" this time. It will try again at the next scheduled time, or run it now from the Scheduled tab.`;
}
