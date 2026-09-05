/** Follow-up links in the Omni format: [Question text](?ai-query=Question%20text). */
const followUpLinkPattern = /\[([^\]\n]{4,200})\]\(\?ai-query=[^)\s]{1,600}\)/gu;

export function extractOmniFollowUps(answer: string): Readonly<{
  text: string;
  followUps: readonly string[];
}> {
  const followUps: string[] = [];
  for (const match of answer.matchAll(followUpLinkPattern)) {
    const label = match[1]?.trim();
    if (label && !followUps.includes(label)) followUps.push(label);
    if (followUps.length >= 3) break;
  }
  // Remove a trailing follow-up block (a run of link-only lines, optionally
  // introduced by a short heading) so the chips are not repeated in prose.
  const lines = answer.split("\n");
  let cut = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line === "") { cut = index; continue; }
    const linkOnly = /^(?:[-*\d.)\s]*)\[[^\]\n]+\]\(\?ai-query=[^)\s]+\)[.:]?$/u.test(line);
    const heading = /^#{0,4}\s*(?:follow[- ]?ups?|next steps?|you (?:could|might) also ask)[:.]?$/iu.test(line);
    if (linkOnly || heading) { cut = index; continue; }
    break;
  }
  let trimmed = cut < lines.length ? lines.slice(0, cut).join("\n").trimEnd() : answer;
  // A stripped follow-up block often had a one-line lead-in ("You could also
  // ask:" / "I can next run any of these:"); an orphaned colon line reads as
  // a truncation, so it leaves with the block it introduced.
  if (cut < lines.length) {
    const remaining = trimmed.split("\n");
    const last = remaining.at(-1)?.trim() ?? "";
    if (/^[^|#>-].{0,120}:$/u.test(last) && !last.includes("|")) {
      trimmed = remaining.slice(0, -1).join("\n").trimEnd();
    }
  }
  return Object.freeze({
    text: trimmed.length > 0 ? trimmed : answer,
    followUps: Object.freeze(followUps.slice(0, 3)),
  });
}
