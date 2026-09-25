import { existsSync } from "node:fs";
import path from "node:path";
import { CODEX_300_QUESTIONS } from "./questions-codex-300.js";
import { percentile, readJsonl, runDir, type EvalTurnRecord } from "./lib.js";

const runFlag = process.argv.indexOf("--run");
const run = runFlag >= 0
  ? process.argv[runFlag + 1]!
  : "codex-subscription-luna-max-fast-300";
const directory = runDir(run);
const resultRows = readJsonl<EvalTurnRecord>(path.join(directory, "results.jsonl"));
const gradeRows = readJsonl<Readonly<{ id: string; error?: string; pass?: boolean }>>(
  path.join(directory, "grades.jsonl"),
);
const latestResults = new Map(resultRows.map((record) => [record.id, record] as const));
const latestGrades = new Map(gradeRows.map((grade) => [grade.id, grade] as const));
const expected = new Set(CODEX_300_QUESTIONS.map((question) => question.id));
const missingResults = [...expected].filter((id) => !latestResults.has(id));
const missingGrades = [...expected].filter((id) => !latestGrades.has(id));
const wrongConfiguration = [...latestResults.values()].filter((record) => (
  record.authenticationMode !== "chatgpt"
  || record.model !== "gpt-5.6-luna"
  || record.reasoningEffort !== "max"
  || record.fastMode !== true
));
const graderErrors = [...latestGrades.values()].filter((grade) => grade.error);
const durations = [...latestResults.values()].map((record) => record.durationMs);
const summary = {
  run,
  expectedTurns: expected.size,
  completedTurns: [...expected].filter((id) => latestResults.has(id)).length,
  gradedTurns: [...expected].filter((id) => latestGrades.has(id)).length,
  missingResults,
  missingGrades,
  wrongConfiguration: wrongConfiguration.map((record) => record.id),
  graderErrors: graderErrors.map((grade) => grade.id),
  modelFailures: [...latestResults.values()].filter((record) => record.failed).length,
  passedGrades: [...latestGrades.values()].filter((grade) => grade.pass === true).length,
  latencySeconds: {
    p50: (percentile(durations, 50) ?? 0) / 1_000,
    p95: (percentile(durations, 95) ?? 0) / 1_000,
    max: durations.length ? Math.max(...durations) / 1_000 : 0,
  },
  reportExists: existsSync(path.join(directory, "report.md")),
};
console.log(JSON.stringify(summary, null, 2));
if (
  missingResults.length
  || missingGrades.length
  || wrongConfiguration.length
  || graderErrors.length
  || !summary.reportExists
) {
  process.exitCode = 1;
}
