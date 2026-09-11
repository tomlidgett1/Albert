function letters(index: number): string {
  return index < 26 ? String.fromCharCode(97 + index) : `${letters(Math.floor(index / 26) - 1)}${letters(index % 26)}`;
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
