import { CODEX_QUESTIONS } from "./questions-codex-bikeshop.js";
import { QUESTIONS, type EvalQuestion } from "./questions.js";

/**
 * The subscription development battery keeps the complete 279-turn regression
 * matrix (including its 31 real multi-turn threads), then adds 21 of the
 * Codex-specific deep/strategic cases. The explicit extra ids make the corpus
 * reviewable and stable instead of depending on array order or random seeds.
 */
export const CODEX_300_EXTRA_IDS = Object.freeze([
  "CH-01", "CH-02", "CH-03", "CH-04", "CH-05", "CH-06", "CH-07", "CH-08",
  "CX-01", "CX-02", "CX-03", "CX-04", "CX-05", "CX-06",
  "CD-02", "CD-03", "CD-04",
  "CT-01", "CT-02",
  "GS-01", "GS-02",
] as const);

const extrasById = new Map(CODEX_QUESTIONS.map((question) => [question.id, question] as const));
const extras: EvalQuestion[] = CODEX_300_EXTRA_IDS.map((id) => {
  const question = extrasById.get(id);
  if (!question) throw new Error(`Unknown Codex 300 extra question id: ${id}`);
  return Object.freeze({ ...question, id: `B-${question.id}` });
});

export const CODEX_300_QUESTIONS: readonly EvalQuestion[] = Object.freeze([
  ...QUESTIONS,
  ...extras,
]);

if (CODEX_300_QUESTIONS.length !== 300) {
  throw new Error(`Codex subscription corpus must contain 300 turns, found ${CODEX_300_QUESTIONS.length}.`);
}
if (new Set(CODEX_300_QUESTIONS.map((question) => question.id)).size !== 300) {
  throw new Error("Codex subscription corpus contains duplicate question ids.");
}
