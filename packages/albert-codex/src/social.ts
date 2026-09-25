export type CodexSocialKind = "greeting" | "thanks" | "acknowledgement" | "farewell";

const GREETING = new Set(["hi", "hello", "hey", "howdy", "gday", "hiya", "morning", "afternoon", "evening", "greetings"]);
const THANKS = new Set(["thanks", "thank", "thankyou", "thx", "cheers", "ta", "appreciated", "appreciate", "legend", "lifesaver"]);
const FAREWELL = new Set(["bye", "goodbye", "cya", "seeya", "ciao", "goodnight", "night", "later"]);
const ACKNOWLEDGEMENT = new Set([
  "great", "awesome", "perfect", "cool", "nice", "brilliant", "lovely", "excellent", "wonderful",
  "sweet", "understood", "noted", "fantastic", "amazing", "superb", "interesting", "helpful", "wow",
  "haha", "lol", "gotcha", "roger", "copy",
]);
const FILLER = new Set([
  "a", "lot", "so", "much", "very", "heaps", "that", "thats", "this", "is", "it", "all", "for", "the",
  "help", "your", "you", "i", "need", "needed", "what", "was", "exactly", "mate", "albert", "good", "one",
  "stuff", "work", "job", "done", "well", "will", "do", "thatll", "makes", "sense", "helps", "super",
  "worries", "problem", "no", "everything", "enough", "today", "again", "soon", "tomorrow", "see", "catch",
  "day", "have", "take", "care", "too", "as", "and", "really", "of", "kind", "got", "sounds", "looks",
  "love", "spot", "bang", "on", "top", "to", "know", "youre", "rock", "are", "star", "yeah", "yep", "yup",
  "fine", "right", "there", "now", "then", "ill", "be", "back", "chat", "talk", "off", "many", "big",
  "week", "weekend", "with", "up", "buddy", "champ", "boss", "friend", "team", "guys", "u", "ur", "im",
]);
const FILLER_PHRASES = new Set([
  "no worries", "all good", "got it", "will do", "makes sense", "sounds good", "looks good", "good stuff",
  "good to know", "good one", "nice one", "spot on", "bang on", "good work", "good job", "well done",
  "you are a star", "youre a star", "love it", "top work", "that helps", "very helpful", "that is all",
  "thats all", "thats all for now", "thats everything", "thats it", "that will do", "thatll do",
]);
const AMBIGUOUS_BARE_AGREEMENT = new Set(["ok", "okay", "kk", "yes", "sure"]);
const ANY_SOCIAL = new Set([...GREETING, ...THANKS, ...FAREWELL, ...ACKNOWLEDGEMENT]);

function tokens(message: string): string[] {
  return message
    .toLowerCase()
    .replace(/[’']/gu, "")
    .replace(/[^a-z\s]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
}

/** Conservative deterministic door: ambiguous bare agreement stays analytical. */
export function detectCodexSocialMessage(message: string): CodexSocialKind | null {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 80) return null;
  const words = tokens(trimmed);
  if (words.length === 0 || words.length > 12) return null;
  if (words.length === 1 && AMBIGUOUS_BARE_AGREEMENT.has(words[0]!)) return null;
  if (words.some((word) => !FILLER.has(word) && !ANY_SOCIAL.has(word))) return null;
  const core = words.filter((word) => ANY_SOCIAL.has(word));
  if (core.length === 0) return FILLER_PHRASES.has(words.join(" ")) ? "acknowledgement" : null;
  if (core.some((word) => THANKS.has(word))) return "thanks";
  if (core.some((word) => FAREWELL.has(word))) return "farewell";
  if (core.some((word) => GREETING.has(word))) return "greeting";
  return "acknowledgement";
}

export function codexSocialReply(kind: CodexSocialKind, message: string): Readonly<{
  text: string;
  followUps: readonly string[];
}> {
  const words = tokens(message);
  if (kind === "greeting") {
    const timeOfDay = words.find((word) => ["morning", "afternoon", "evening"].includes(word));
    return {
      text: `${timeOfDay ? `Good ${timeOfDay}.` : "Hi."} Ask me anything about the business when you’re ready.`,
      followUps: [],
    };
  }
  if (kind === "thanks") return { text: "You’re welcome.", followUps: [] };
  if (kind === "farewell") return { text: "Bye for now.", followUps: [] };
  return { text: "Glad that helped.", followUps: [] };
}

export function codexSocialProvenance() {
  return {
    sources: [],
    timeRange: {
      label: "Not applicable — conversational reply",
      start: "unknown",
      end: "unknown",
      timezone: "UTC",
    },
    definitions: [],
    semanticBundleHash: "albert-codex-social-v1",
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
  } as const;
}
