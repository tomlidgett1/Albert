/**
 * Shared-period resolution for a Swarm run (ADR 0120).
 *
 * Every worker must query the same days. Period grounding is Codex's
 * biggest measured failure mode (ADR 0114), so the window is resolved once
 * here into explicit ISO dates instead of letting each child re-interpret
 * a free-text label. Pure date arithmetic, no model, no Cube.
 */
import { z } from "zod";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 86_400_000;
const MAX_WINDOW_DAYS = 400;

export const SWARM_DEFAULT_TIMEZONE = "Australia/Sydney";

export const swarmPeriodWindowSchema = z.object({
  start: z.string().regex(ISO_DATE),
  end: z.string().regex(ISO_DATE),
  compareStart: z.string().regex(ISO_DATE),
  compareEnd: z.string().regex(ISO_DATE),
}).strict();

export type SwarmPeriodWindow = z.infer<typeof swarmPeriodWindowSchema>;

function utcDay(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function shiftDays(date: string, days: number): string {
  return new Date(utcDay(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function localIsoDate(now: Date, timezone: string): string {
  const options = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, ...options }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: SWARM_DEFAULT_TIMEZONE, ...options }).format(now);
  }
}

/** Trailing 13 weeks ending yesterday against the 13 weeks before them. */
export function defaultSwarmPeriod(now: Date, timezone: string): SwarmPeriodWindow {
  const end = shiftDays(localIsoDate(now, timezone), -1);
  const start = shiftDays(end, -90);
  const compareEnd = shiftDays(start, -1);
  const compareStart = shiftDays(compareEnd, -90);
  return { start, end, compareStart, compareEnd };
}

export function validSwarmPeriod(period: SwarmPeriodWindow, now: Date, timezone: string): boolean {
  const days = [period.start, period.end, period.compareStart, period.compareEnd].map(utcDay);
  if (days.some((value) => Number.isNaN(value))) return false;
  const [start, end, compareStart, compareEnd] = days as [number, number, number, number];
  if (start > end || compareStart > compareEnd) return false;
  if (compareEnd >= start) return false;
  if ((end - start) / DAY_MS > MAX_WINDOW_DAYS) return false;
  if ((compareEnd - compareStart) / DAY_MS > MAX_WINDOW_DAYS) return false;
  return end <= utcDay(localIsoDate(now, timezone)) + DAY_MS;
}

export function swarmPeriodPromptLines(label: string, period: SwarmPeriodWindow): string {
  return [
    `Shared period every agent must use: ${label}`,
    `Query window: ${period.start} to ${period.end} (inclusive). Comparison window: ${period.compareStart} to ${period.compareEnd}.`,
    `Query exactly these dates. Do not re-derive the period from the question.`,
  ].join("\n");
}
