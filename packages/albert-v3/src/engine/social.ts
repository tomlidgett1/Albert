import type { ConversationMessage } from "./orchestrator.js";

/**
 * Social turns: greetings, thanks, acknowledgements and sign-offs. They carry
 * no question, so nothing is planned, queried or verified — Albert replies in a
 * sentence and the turn ends. Two doors lead here: this deterministic detector
 * (zero model calls, runs before the catalogue fetch and the classifier) and
 * the classifier's own `social` lane for wording the detector does not know.
 */
export type SocialKind = "greeting" | "thanks" | "acknowledgement" | "farewell";

const GREETING = new Set(["hi", "hello", "hey", "howdy", "gday", "hiya", "yo", "morning", "afternoon", "evening", "greetings"]);
const THANKS = new Set(["thanks", "thank", "thankyou", "thx", "ty", "cheers", "ta", "appreciated", "appreciate", "legend", "lifesaver"]);
const FAREWELL = new Set(["bye", "goodbye", "cya", "seeya", "ciao", "goodnight", "night", "later"]);
const ACKNOWLEDGEMENT = new Set([
  "ok", "okay", "kk", "great", "awesome", "perfect", "cool", "nice", "brilliant", "lovely", "excellent",
  "wonderful", "sweet", "understood", "noted", "fantastic", "amazing", "superb", "interesting", "helpful",
  "wow", "haha", "lol", "gotcha", "roger", "copy",
]);
// Words that may accompany a social word without turning the message into a
// question. Anything outside these sets (a figure, a product, "sales", "now",
// "show") disqualifies the message from the deterministic door.
const FILLER = new Set([
  "a", "lot", "so", "much", "very", "heaps", "that", "thats", "this", "is", "it", "all", "for", "the",
  "help", "your", "you", "i", "need", "needed", "what", "was", "exactly", "mate", "albert", "good", "one",
  "stuff", "work", "job", "done", "well", "will", "do", "thatll", "makes", "sense", "helps", "super",
  "worries", "problem", "no", "everything", "enough", "today", "again", "soon", "tomorrow", "see", "catch",
  "day", "have", "take", "care", "too", "as", "and", "really", "of", "kind", "got", "sounds", "looks",
  "love", "spot", "bang", "on", "top", "to", "know", "youre", "rock", "are", "star", "yes", "yeah", "yep",
  "yup", "sure", "fine", "right", "there", "now", "then", "ill", "be", "back", "chat", "talk", "off",
  "many", "cheers", "big", "week", "weekend", "evening", "morning", "afternoon", "night", "with", "up",
  "buddy", "man", "champ", "boss", "friend", "team", "yall", "guys", "u", "ur", "im", "id", "hows",
]);
const ANY_SOCIAL = new Set([...GREETING, ...THANKS, ...FAREWELL, ...ACKNOWLEDGEMENT]);
// Acknowledgements made of filler words only.
const FILLER_PHRASES = new Set([
  "no worries", "all good", "got it", "will do", "makes sense", "sounds good", "looks good", "good stuff",
  "good to know", "good one", "nice one", "spot on", "bang on", "good work", "good job", "well done",
  "you are a star", "youre a star", "love it", "top work", "that helps", "very helpful", "that is all",
  "thats all", "thats all for now", "that is all for now", "thats everything", "thats it", "that will do", "thatll do",
]);

function tokens(message: string): string[] {
  return message
    .toLowerCase()
    .replace(/[’']/gu, "")
    .replace(/[^a-z\s]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
}

/** True when the assistant's last message is a question the owner may be answering. */
function lastAssistantAsked(conversation: readonly ConversationMessage[]): boolean {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message?.role !== "assistant") continue;
    return /\?\s*$/u.test(message.text.trim());
  }
  return false;
}

/**
 * Deterministic door: a short message made only of social words. Bare
 * agreement ("yes", "ok", "sure") right after Albert asked a question is an
 * answer to that question, not chit-chat, so it is left to the classifier.
 */
export function detectSocialMessage(
  message: string,
  conversation: readonly ConversationMessage[] = [],
): SocialKind | null {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 80) return null;
  const words = tokens(trimmed);
  if (words.length === 0 || words.length > 12) return null;
  if (words.some((word) => !FILLER.has(word) && !ANY_SOCIAL.has(word))) return null;
  const core = words.filter((word) => ANY_SOCIAL.has(word));
  if (core.length === 0) {
    // Fixed phrases built from filler words alone.
    return FILLER_PHRASES.has(words.join(" ")) ? "acknowledgement" : null;
  }
  const has = (set: Set<string>) => core.some((word) => set.has(word));
  if (has(THANKS)) return "thanks";
  if (has(FAREWELL)) return "farewell";
  if (has(GREETING)) return "greeting";
  // Bare agreement ("ok", "okay then") right after Albert asked something is
  // an answer to that question, not chit-chat.
  const bareAgreement = core.every((word) => word === "ok" || word === "okay" || word === "kk");
  if (bareAgreement && lastAssistantAsked(conversation)) return null;
  return "acknowledgement";
}

/**
 * The classifier routed `social` on wording the detector did not recognise:
 * pick the closest kind from the message so the reply still fits.
 */
export function inferSocialKind(message: string): SocialKind {
  const words = new Set(tokens(message));
  if ([...words].some((word) => THANKS.has(word))) return "thanks";
  if ([...words].some((word) => FAREWELL.has(word))) return "farewell";
  if ([...words].some((word) => GREETING.has(word))) return "greeting";
  return "acknowledgement";
}

const STARTER_FOLLOW_UPS = [
  "How did sales go this month compared to last month?",
  "Which categories make the most gross profit?",
  "Who are my top customers this year?",
] as const;

export function socialReply(kind: SocialKind, message: string): Readonly<{ text: string; followUps: readonly string[] }> {
  const words = tokens(message);
  switch (kind) {
    case "greeting": {
      const timeOfDay = words.find((word) => word === "morning" || word === "afternoon" || word === "evening");
      const opener = timeOfDay ? `Good ${timeOfDay}.` : "Hi.";
      return {
        text: `${opener} Ask me anything about the business — sales, customers, accounting or staff — and I'll pull the figures.`,
        followUps: STARTER_FOLLOW_UPS,
      };
    }
    case "thanks":
      return { text: "You're welcome. Ask whenever you need another figure.", followUps: [] };
    case "farewell":
      return { text: "Bye for now — I'll be here when you need the next figure.", followUps: [] };
    case "acknowledgement":
    default:
      return { text: "Great. I'm here when you're ready for the next one.", followUps: [] };
  }
}
