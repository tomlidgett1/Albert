import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertV2EvaluationCorpus,
  type V2EvaluationCase,
} from "./v2-evaluation-policy.js";
import {
  gradeV2ModelEvaluation,
  type HumanEvaluationReview,
} from "./v2-evaluation-grading.js";
import type { V2OwnerReviewWaiver } from "./v2-owner-review-waiver.js";

const summaryPath = process.argv[2];
const corpusPath = process.argv[3] ?? "evals/v2-evaluation-corpus.json";
const humanReviewPath = process.argv[4];
const ownerReviewWaiverPath = process.argv[5];
if (!summaryPath)
  throw new Error(
    "Usage: grade-v2-model-evaluation <summary.json> [corpus.json] [human-review.json]",
  );
const corpus: unknown = JSON.parse(readFileSync(corpusPath, "utf8"));
assertV2EvaluationCorpus(corpus);
const results = JSON.parse(
  readFileSync(summaryPath, "utf8"),
) as readonly Record<string, unknown>[];
const humanReviews = humanReviewPath
  ? (JSON.parse(
      readFileSync(humanReviewPath, "utf8"),
    ) as readonly HumanEvaluationReview[])
  : [];
const ownerReviewWaiver = ownerReviewWaiverPath
  ? (JSON.parse(
      readFileSync(ownerReviewWaiverPath, "utf8"),
    ) as V2OwnerReviewWaiver)
  : undefined;
const publicationHash = process.env.ALBERT_SEMANTIC_V2_PUBLICATION_HASH?.trim();
const commit = process.env.ALBERT_AGENT_QA_COMMIT_SHA?.trim();
const corpusHash = process.env.ALBERT_V2_EVALUATION_CORPUS_HASH?.trim();
const visibleCorpusHash =
  process.env.ALBERT_V2_EVALUATION_VISIBLE_CORPUS_HASH?.trim();
const holdoutCorpusHash =
  process.env.ALBERT_V2_EVALUATION_HOLDOUT_CORPUS_HASH?.trim();
const goldManifestHash =
  process.env.ALBERT_V2_EVALUATION_GOLD_MANIFEST_HASH?.trim();
const datasetWatermarkHash =
  process.env.ALBERT_V2_EVALUATION_DATASET_WATERMARK_HASH?.trim();
const deterministicReceiptHash =
  process.env.ALBERT_V2_DETERMINISTIC_RECEIPT_HASH?.trim();
const runId = process.env.ALBERT_AGENT_QA_RUN_ID?.trim();
const sha256Values = [
  publicationHash,
  corpusHash,
  visibleCorpusHash,
  holdoutCorpusHash,
  goldManifestHash,
  datasetWatermarkHash,
  deterministicReceiptHash,
];
if (
  sha256Values.some((value) => !value || !/^[a-f0-9]{64}$/u.test(value)) ||
  !commit ||
  !/^[a-f0-9]{40}$/u.test(commit) ||
  !runId
) {
  throw new Error(
    "Grading requires exact publication, deterministic qualification, corpus, holdout, gold, dataset-watermark, and 40-character commit bindings.",
  );
}
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
const actualCorpusHash = createHash("sha256")
  .update(JSON.stringify(canonical(corpus)))
  .digest("hex");
if (actualCorpusHash !== corpusHash)
  throw new Error(
    "The grading corpus does not match the sealed launch corpus hash.",
  );
const receipt = gradeV2ModelEvaluation(
  corpus as readonly V2EvaluationCase[],
  results as never,
  humanReviews,
  {
    publicationHash: publicationHash!,
    commit,
    runId,
    corpusHash: corpusHash!,
    visibleCorpusHash: visibleCorpusHash!,
    holdoutCorpusHash: holdoutCorpusHash!,
    goldManifestHash: goldManifestHash!,
    datasetWatermarkHash: datasetWatermarkHash!,
    deterministicReceiptHash: deterministicReceiptHash!,
  },
  ownerReviewWaiver,
);
const outputPath = resolve(summaryPath, "..", "grade.json");
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ outputPath, status: receipt.status, failedGates: receipt.failedGates }, null, 2)}\n`,
);
if (receipt.status === "failed") process.exitCode = 1;
