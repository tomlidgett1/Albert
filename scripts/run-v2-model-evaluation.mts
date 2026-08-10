import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import {
  applyV2EvaluationGold,
  assertNoConflictingV2EvaluationEnvironment,
  assertV2PublicEvaluationBlueprint,
  bindV2SealedHoldout,
  V2_EVALUATION_RUNTIME,
  v2EvaluationEnvironment,
} from "./v2-evaluation-policy.js";

const corpusPath = "evals/v2-evaluation-corpus.json";
const publicCorpus: unknown = JSON.parse(readFileSync(corpusPath, "utf8"));

if (
  !process.argv.includes("--execute") ||
  !process.argv.includes("--confirm-budget=200")
) {
  throw new Error(
    "Refusing to spend the model-backed evaluation budget without --execute --confirm-budget=200.",
  );
}
assertV2PublicEvaluationBlueprint(publicCorpus);
assertNoConflictingV2EvaluationEnvironment(process.env);

try {
  process.loadEnvFile?.(".env.local");
} catch {
  /* Explicit process environment remains authoritative. */
}
const effectiveEnvironment = {
  ...process.env,
  ...v2EvaluationEnvironment(),
} as Record<string, string>;
const publicationHash =
  effectiveEnvironment.ALBERT_SEMANTIC_V2_PUBLICATION_HASH?.trim();
if (!publicationHash || !/^[a-f0-9]{64}$/u.test(publicationHash))
  throw new Error(
    "ALBERT_SEMANTIC_V2_PUBLICATION_HASH must pin the exact qualified publication before evaluation.",
  );
const holdoutPathValue =
  effectiveEnvironment.ALBERT_V2_EVALUATION_HOLDOUT_PATH?.trim();
if (!holdoutPathValue)
  throw new Error(
    "ALBERT_V2_EVALUATION_HOLDOUT_PATH must point to the sealed 40-case holdout outside the repository.",
  );
const holdoutPath = resolve(holdoutPathValue);
const repositoryRelativeHoldout = relative(resolve("."), holdoutPath);
if (
  !repositoryRelativeHoldout.startsWith("..") ||
  repositoryRelativeHoldout === ""
)
  throw new Error(
    "The sealed holdout must not be stored inside the repository.",
  );
const holdout: unknown = JSON.parse(readFileSync(holdoutPath, "utf8"));
const visible = (publicCorpus as readonly Record<string, unknown>[]).filter(
  ({ visibility }) => visibility === "visible",
);
if (visible.length !== 160)
  throw new Error(
    "The committed regression corpus must contain exactly 160 visible cases.",
  );
const unboundCorpus = bindV2SealedHoldout(publicCorpus, holdout);
const goldPathValue =
  effectiveEnvironment.ALBERT_V2_EVALUATION_GOLD_PATH?.trim();
if (!goldPathValue)
  throw new Error(
    "ALBERT_V2_EVALUATION_GOLD_PATH must point to the dataset-bound deterministic gold manifest outside the repository.",
  );
const goldPath = resolve(goldPathValue);
const repositoryRelativeGold = relative(resolve("."), goldPath);
if (!repositoryRelativeGold.startsWith("..") || repositoryRelativeGold === "")
  throw new Error(
    "The deterministic gold manifest must not be stored inside the repository.",
  );
const rawGoldManifest: unknown = JSON.parse(readFileSync(goldPath, "utf8"));
const appliedGold = applyV2EvaluationGold(
  unboundCorpus,
  rawGoldManifest,
  publicationHash,
);
const corpus = appliedGold.cases;
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;
const corpusHash = createHash("sha256")
  .update(JSON.stringify(canonical(corpus)))
  .digest("hex");
const visibleCorpusHash = createHash("sha256")
  .update(JSON.stringify(canonical(visible)))
  .digest("hex");
const holdoutCorpusHash = createHash("sha256")
  .update(JSON.stringify(canonical(holdout)))
  .digest("hex");
const goldManifestHash = createHash("sha256")
  .update(JSON.stringify(canonical(rawGoldManifest)))
  .digest("hex");
const semanticUrl = effectiveEnvironment.SEMANTIC_QUERY_SERVICE_URL?.trim();
if (!semanticUrl)
  throw new Error(
    "SEMANTIC_QUERY_SERVICE_URL is required for the V2 evaluation preflight.",
  );
const readinessResponse = await fetch(new URL("/readyz", semanticUrl), {
  signal: AbortSignal.timeout(10_000),
});
const readiness = (await readinessResponse.json()) as Record<string, unknown>;
if (
  !readinessResponse.ok ||
  readiness.status !== "ready" ||
  readiness.analyticalRuntime !== "v2" ||
  readiness.v2PublicationHash !== publicationHash
) {
  throw new Error(
    `The semantic service is not ready on V2 with publication ${publicationHash}.`,
  );
}
const openaiApiKey = effectiveEnvironment.OPENAI_API_KEY?.trim();
const openaiBaseUrl = effectiveEnvironment.OPENAI_BASE_URL?.trim();
if (!openaiApiKey || !openaiBaseUrl)
  throw new Error(
    "OPENAI_API_KEY and OPENAI_BASE_URL are required for the model-identity preflight.",
  );
const modelResponse = await fetch(
  `${openaiBaseUrl.replace(/\/+$/u, "")}/models/${V2_EVALUATION_RUNTIME.model}`,
  {
    headers: { Authorization: `Bearer ${openaiApiKey}` },
    signal: AbortSignal.timeout(10_000),
  },
);
const modelIdentity = (await modelResponse.json()) as Record<string, unknown>;
if (
  !modelResponse.ok ||
  modelIdentity.object !== "model" ||
  modelIdentity.id !== V2_EVALUATION_RUNTIME.model
)
  throw new Error(
    `The configured OpenAI project cannot prove access to the exact model ${V2_EVALUATION_RUNTIME.model}.`,
  );
const commit =
  effectiveEnvironment.ALBERT_RELEASE_SHA?.trim() ||
  spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
if (!/^[a-f0-9]{40}$/u.test(commit))
  throw new Error(
    "The evaluation runner could not resolve an exact 40-character commit SHA.",
  );
const deterministicReceiptPath =
  effectiveEnvironment.ALBERT_V2_DETERMINISTIC_RECEIPT_PATH?.trim();
if (!deterministicReceiptPath)
  throw new Error(
    "ALBERT_V2_DETERMINISTIC_RECEIPT_PATH must identify the passed deterministic qualification receipt before evaluation.",
  );
const deterministicReceipt = JSON.parse(
  readFileSync(resolve(deterministicReceiptPath), "utf8"),
) as Record<string, unknown>;
const deterministicSuites = Array.isArray(deterministicReceipt.suites)
  ? (deterministicReceipt.suites as Record<string, unknown>[])
  : [];
if (
  deterministicReceipt.status !== "passed" ||
  deterministicReceipt.publicationHash !== publicationHash ||
  deterministicReceipt.commit !== commit ||
  !deterministicSuites.some(
    ({ name, status }) =>
      name === "physical-staging-contract" && status === "passed",
  )
)
  throw new Error(
    "The exact publication and commit have not passed deterministic qualification including the live physical-staging contract audit.",
  );
const deterministicReceiptHash = createHash("sha256")
  .update(JSON.stringify(canonical(deterministicReceipt)))
  .digest("hex");
const runId =
  effectiveEnvironment.ALBERT_AGENT_QA_RUN_ID?.trim() ||
  `v2-${commit.slice(0, 12)}-${publicationHash.slice(0, 12)}`;
mkdirSync(resolve(".albert-agent-qa-out"), { recursive: true });
const lockPath = resolve(
  ".albert-agent-qa-out",
  `budget-${commit}-${publicationHash}.json`,
);
let lockDescriptor: number;
try {
  lockDescriptor = openSync(lockPath, "wx");
} catch {
  throw new Error(
    `The 200-case budget is already reserved for this commit and publication (${lockPath}). Automatic reruns are prohibited.`,
  );
}
const launchReceipt = {
  event: "v2_evaluation_launch_receipt",
  runId,
  caseCount: corpus.length,
  commit,
  publicationHash,
  corpusHash,
  visibleCorpusHash,
  holdoutCorpusHash,
  goldManifestHash,
  deterministicReceiptHash,
  datasetWatermarkHash: appliedGold.datasetWatermarkHash,
  semanticUrl,
  serviceReadiness: readiness,
  modelIdentity: Object.freeze({
    id: modelIdentity.id,
    object: modelIdentity.object,
  }),
  ...V2_EVALUATION_RUNTIME,
  startedAt: new Date().toISOString(),
  status: "launched",
};
writeSync(lockDescriptor, `${JSON.stringify(launchReceipt, null, 2)}\n`);
closeSync(lockDescriptor);

process.stderr.write(`${JSON.stringify(launchReceipt)}\n`);

const childEnvironment = {
  ...process.env,
  ...effectiveEnvironment,
  ALBERT_AGENT_QA_RUN_ID: runId,
  ALBERT_AGENT_QA_COMMIT_SHA: commit,
  ALBERT_V2_EVALUATION_CORPUS_HASH: corpusHash,
  ALBERT_V2_EVALUATION_VISIBLE_CORPUS_HASH: visibleCorpusHash,
  ALBERT_V2_EVALUATION_HOLDOUT_CORPUS_HASH: holdoutCorpusHash,
  ALBERT_V2_EVALUATION_GOLD_MANIFEST_HASH: goldManifestHash,
  ALBERT_V2_EVALUATION_DATASET_WATERMARK_HASH: appliedGold.datasetWatermarkHash,
  ALBERT_V2_DETERMINISTIC_RECEIPT_HASH: deterministicReceiptHash,
} as NodeJS.ProcessEnv;
const combinedCorpusPath = resolve(
  ".albert-agent-qa-out",
  runId,
  "sealed-corpus.json",
);
mkdirSync(resolve(".albert-agent-qa-out", runId), { recursive: true });
writeFileSync(combinedCorpusPath, `${JSON.stringify(corpus, null, 2)}\n`, {
  mode: 0o600,
});
const child = spawn(
  process.execPath,
  ["--import", "tsx", ".albert-agent-qa.mts", combinedCorpusPath],
  {
    stdio: "inherit" as const,
    env: childEnvironment,
  },
);
const exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code: number | null) => resolve(code ?? 1));
});
let gradeReceipt: Record<string, unknown> | null = null;
let finalExitCode = exitCode;
if (exitCode === 0) {
  const summaryPath = resolve(".albert-agent-qa-out", runId, "summary.json");
  const grader = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/grade-v2-model-evaluation.mts",
      summaryPath,
      combinedCorpusPath,
    ],
    { stdio: "inherit", env: childEnvironment },
  );
  finalExitCode = grader.status ?? 1;
  if (finalExitCode === 0)
    gradeReceipt = JSON.parse(
      readFileSync(
        resolve(".albert-agent-qa-out", runId, "grade.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
}
writeFileSync(
  lockPath,
  `${JSON.stringify({ ...launchReceipt, completedAt: new Date().toISOString(), status: finalExitCode === 0 ? (gradeReceipt?.status ?? "completed") : "failed", exitCode: finalExitCode, gradeReceipt }, null, 2)}\n`,
);
process.exit(finalExitCode);
