/**
 * Distil a codex research answer into control-panel card fields (ADR 0113).
 *
 * The roster prompts ask every agent to lead with a '## ' headline and a
 * 'Key numbers' bullet list; this parser recovers those, and degrades to the
 * first substantive line when a model ignored the format. Pure and total: any
 * string in, card fields out.
 */

export type ProactiveKeyNumber = Readonly<{ label: string; value: string }>;

export type DistilledProactiveAnswer = Readonly<{
  headline: string;
  keyNumbers: readonly ProactiveKeyNumber[];
}>;

const HEADLINE_MAX = 300;
const KEY_NUMBER_MAX = 6;

const headingLine = /^#{1,4}\s+(.+)$/u;
const boldBullet = /^[-*•]\s+\*\*(.+?)\*\*[:：]?\s*(.+)$/u;

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/gu, "$1")
    .replace(/\*(.+?)\*/gu, "$1")
    .replace(/`(.+?)`/gu, "$1")
    .trim();
}

export function distillProactiveAnswer(answer: string): DistilledProactiveAnswer {
  const lines = answer.replace(/\r\n/gu, "\n").split("\n");

  // Prefer a heading within the first few substantive lines (the roster asks
  // for a leading '## ' headline); otherwise the first substantive line.
  let headline = "";
  let firstLine = "";
  let seen = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    seen += 1;
    const heading = headingLine.exec(trimmed);
    if (heading) {
      headline = stripInlineMarkdown(heading[1] ?? "");
      break;
    }
    if (!firstLine) firstLine = stripInlineMarkdown(trimmed);
    if (seen >= 4) break;
  }
  if (!headline) headline = firstLine || "Research completed.";

  const keyNumbers: ProactiveKeyNumber[] = [];
  for (const line of lines) {
    if (keyNumbers.length >= KEY_NUMBER_MAX) break;
    const match = boldBullet.exec(line.trim());
    if (!match) continue;
    const label = stripInlineMarkdown(match[1] ?? "").replace(/[:：]\s*$/u, "").slice(0, 80);
    const value = stripInlineMarkdown(match[2] ?? "").replace(/^[—–-]\s*/u, "").slice(0, 200);
    if (label && value) keyNumbers.push({ label, value });
  }

  return {
    headline: headline.slice(0, HEADLINE_MAX),
    keyNumbers,
  };
}
