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

export function protectReportingDates(text: string, sources: readonly { provenance: { timeRange: { start?: string; end?: string } } }[]) {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const phrases = new Set<string>();
  const parts = (raw: string | undefined) => {
    if (!raw || !/^\d{4}-\d{2}-\d{2}/u.test(raw)) return undefined;
    const date = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw.slice(0, 10)) return undefined;
    const value = { day: date.getUTCDate(), month: months[date.getUTCMonth()]!, year: date.getUTCFullYear() };
    phrases.add(raw.slice(0, 10));
    for (const month of [value.month, value.month.slice(0, 3)]) {
      phrases.add(`${value.day} ${month} ${value.year}`);
      phrases.add(`${month} ${value.year}`);
    }
    return value;
  };
  for (const source of sources) {
    const start = parts(source.provenance.timeRange.start), end = parts(source.provenance.timeRange.end);
    if (!start || !end) continue;
    for (const short of [false, true]) {
      const sm = short ? start.month.slice(0, 3) : start.month;
      const em = short ? end.month.slice(0, 3) : end.month;
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
