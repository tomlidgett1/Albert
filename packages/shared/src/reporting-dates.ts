function letters(index: number): string {
  return index < 26 ? String.fromCharCode(97 + index) : `${letters(Math.floor(index / 26) - 1)}${letters(index % 26)}`;
}

/** Display full-day ISO ranges without inventing or discarding a partial window. */
export function formatReportingRange(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?Z?)?\s+(?:to|[-–])\s+(\d{4}-\d{2}-\d{2})(?:T23:59:59(?:\.999)?Z?)?$/u.exec(value);
  if (!match) return value;
  const start = new Date(`${match[1]}T00:00:00Z`), end = new Date(`${match[2]}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end
    || start.toISOString().slice(0, 10) !== match[1] || end.toISOString().slice(0, 10) !== match[2]) return value;
  const sameMonth = start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth();
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  if (sameMonth && start.getUTCDate() === 1 && end.getUTCDate() === lastDay) {
    return new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric", timeZone: "UTC" }).format(start);
  }
  const date = (input: Date) => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(input);
  return start.getTime() === end.getTime() ? date(start) : `${date(start)}–${date(end)}`;
}

export function formatReportingPeriodLabel(value: string): string {
  const compared = /^Comparing (.+) vs (.+)$/u.exec(value);
  return compared ? `${formatReportingRange(compared[1]!)} vs ${formatReportingRange(compared[2]!)}` : formatReportingRange(value);
}

type ReportingEvidence = { provenance: { timeRange: { start?: string; end?: string; label?: string } }; semantics?: { window?: string } };

function reportingRanges(source: ReportingEvidence): [string, string][] {
  const ranges: [string, string][] = [];
  const add = (value: unknown) => {
    if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(v))) ranges.push(value as [string, string]);
  };
  add([source.provenance.timeRange.start?.slice(0, 10), source.provenance.timeRange.end?.slice(0, 10)]);
  // Comparison queries have no single start/end. Their trusted semantic window
  // carries both actual ranges; a prose label alone must not grant numeric proof.
  try {
    const window: unknown = source.semantics?.window && source.semantics.window.length < 20_000 ? JSON.parse(source.semantics.window) : undefined;
    if (window && typeof window === "object" && "ranges" in window && Array.isArray(window.ranges)) {
      for (const range of window.ranges.slice(0, 30)) {
        if (!range || typeof range !== "object") continue;
        add(range.dateRange);
        if (Array.isArray(range.compareDateRange)) range.compareDateRange.slice(0, 10).forEach(add);
      }
    }
  } catch { /* Legacy non-JSON window labels carry no extra numeric authority. */ }
  return ranges;
}

function smallNumberWords(value: number): string | undefined {
  const small = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  if (value < 20) return small[value];
  if (value >= 100) return undefined;
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  return `${tens[Math.floor(value / 10)]}${value % 10 ? `-${small[value % 10]}` : ""}`;
}

export function protectReportingDates(text: string, sources: readonly ReportingEvidence[]) {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const phrases = new Set<string>();
  const forms = (month: string) => [...new Set([month, month.slice(0, 3), ...(month === "September" ? ["Sept"] : [])])];
  const parts = (raw: string | undefined) => {
    if (!raw || !/^\d{4}-\d{2}-\d{2}/u.test(raw)) return undefined;
    const date = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw.slice(0, 10)) return undefined;
    const value = { day: date.getUTCDate(), month: months[date.getUTCMonth()]!, year: date.getUTCFullYear() };
    phrases.add(raw.slice(0, 10));
    for (const month of forms(value.month)) {
      phrases.add(`${value.day} ${month} ${value.year}`);
      phrases.add(`${month} ${value.year}`);
    }
    return value;
  };
  for (const [from, through] of sources.flatMap(reportingRanges)) {
    const start = parts(from), end = parts(through);
    if (!start || !end) continue;
    const weeks = (Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) + 86_400_000) / 604_800_000;
    if (Number.isInteger(weeks) && weeks > 0 && weeks <= 104) {
      for (const count of [String(weeks), smallNumberWords(weeks)].filter((value): value is string => Boolean(value))) {
        phrases.add(`${count} ${weeks === 1 ? "week" : "weeks"}`);
        phrases.add(`${count}-week`);
        for (const qualifier of ["complete", "completed", "full"]) phrases.add(`${count} ${qualifier} ${weeks === 1 ? "week" : "weeks"}`);
      }
    }
    for (const sm of forms(start.month)) for (const em of forms(end.month)) {
      for (const separator of ["–", "-", " to "]) {
        phrases.add(`${start.day} ${sm} ${start.year}${separator}${end.day} ${em} ${end.year}`);
        if (start.year === end.year) phrases.add(`${start.day} ${sm}${separator}${end.day} ${em} ${end.year}`);
        if (start.year === end.year && start.month === end.month) phrases.add(`${start.day}${separator}${end.day} ${em} ${end.year}`);
      }
    }
  }
  let prefix = "ALBERTREPORTINGPERIOD";
  while (text.includes(prefix)) prefix += "X";
  const replacements = new Map<string, string>();
  for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
    const pattern = phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/[–-]/gu, "\\s*[–—-]\\s*").replace(/ /gu, "\\s+");
    text = text.replace(new RegExp(`(?<![\\p{L}\\d$£€¥])${pattern}(?![\\p{L}\\d])`, "giu"), (match, offset: number, original: string) => {
      if (/\b(?:AUD|USD|EUR|GBP)\s*$/iu.test(original.slice(Math.max(0, offset - 8), offset))) return match;
      const token = `${prefix}${letters(replacements.size)}`; replacements.set(token, match); return token;
    });
  }
  return { text, restore: (value: string) => [...replacements].reduce((out, [token, phrase]) => out.replaceAll(token, phrase), value) };
}
