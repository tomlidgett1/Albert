/** Follow-up links in the Omni format: [Question text](?ai-query=Question%20text). */
const followUpLinkPattern = /\[([^\]\n]{4,200})\]\(\?ai-query=[^)\s]{1,600}\)/gu;

/** The opening words of a follow-up that already asks for something ("Show…", "Compare…"). */
const INSTRUCTION = /^(?:show|break|compare|split|list|rank|track|check|look|explain|draft|build|find|chart|plot|give|tell|run|rerun|add|pull|dig|drill|map|forecast|project|estimate|summari[sz]e|highlight|flag|filter|group|sort)\b/iu;
const SEE = "(?:see|view|get|have|look at|know|find out|understand|explore|check|review)";
/** Albert offering to do something, and how the owner would ask for it instead. */
const OFFERS: readonly (readonly [RegExp, string])[] = [
  [/^(?:would|do) you (?:like|want) me to\s+/iu, ""],
  [new RegExp(`^(?:would|do) you (?:like|want) to ${SEE}\\s+`, "iu"), "Show "],
  [/^(?:would|do) you (?:like|want)\s+/iu, "Show "],
  [/^(?:want|need) me to\s+/iu, ""],
  [new RegExp(`^(?:want|need) to ${SEE}\\s+`, "iu"), "Show "],
  [/^want\s+/iu, "Show "],
  [/^would it help to see\s+/iu, "Show "],
  [/^would it help to\s+/iu, ""],
  [/^interested in (?:seeing\s+)?/iu, "Show "],
  [/^(?:should|shall|can|could|may) i\s+/iu, ""],
  [/^shall we\s+/iu, ""],
  [/^(?:i can|i could|let me)\s+/iu, ""],
];

/**
 * A suggested follow-up is sent as the owner's own next message when they tap
 * it, so it is written in their voice: a request ("Show the last sale date
 * for each Trace model") or a question for Albert. Models kept writing them
 * as Albert's offers ("Would you like the last sale date for each Trace
 * model?", "Want me to break this down by category?") or as questions to the
 * owner ("Should you pause new workshop intake?"), which read backwards once
 * sent. An offer becomes the request it offers; "you" and "your" become the
 * business's "we" and "our"; link markup is unwrapped; an offer of nothing in
 * particular ("anything else…") is dropped.
 */
export function ownerVoiceFollowUp(raw: string): string | null {
  let text = raw.replace(/\[([^\]\n]{1,200})\]\([^)\s]*\)/gu, "$1").replace(/\s+/gu, " ").trim();
  if (/\b(?:anything else|let me know|if you(?:['’]d| would) like)\b/iu.test(text)) return null;
  const offer = OFFERS.find(([pattern]) => pattern.test(text));
  if (offer) text = text.replace(offer[0], offer[1]);
  // The offer's question mark goes with it: "Show the trend", not "Show the trend?".
  if (offer && INSTRUCTION.test(text)) text = text.replace(/[?.]+$/u, "");
  text = text
    .replace(/\b(show|tell|give|send|walk) you\b/giu, "$1 me")
    .replace(/\byou(['’])(ve|re|ll|d)\b/giu, (_match, apostrophe: string, rest: string) => `we${apostrophe}${rest}`)
    .replace(/\byourselves\b/giu, "ourselves")
    .replace(/\byours\b/giu, "ours")
    .replace(/\byour\b/giu, "our")
    .replace(/\byou\b/giu, "we")
    .trim();
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return text.length >= 4 ? text : null;
}

export function extractOmniFollowUps(answer: string): Readonly<{
  text: string;
  followUps: readonly string[];
}> {
  const followUps: string[] = [];
  for (const match of answer.matchAll(followUpLinkPattern)) {
    const label = match[1] ? ownerVoiceFollowUp(match[1]) : null;
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
