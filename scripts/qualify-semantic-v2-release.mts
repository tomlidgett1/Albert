import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { ulid } from "ulid";

if (!process.argv.includes("--execute"))
  throw new Error(
    "Refusing to write an activation qualification without --execute.",
  );
function argument(name: string): string {
  const value = process.argv
    .find((item) => item.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
  if (!value) throw new Error(`--${name}=... is required.`);
  return value;
}
const publicationHash = argument("publication");
const commit = argument("commit");
const actorUserId = argument("actor-user-id");
if (
  !/^[a-f0-9]{64}$/u.test(publicationHash) ||
  !/^[a-f0-9]{40}$/u.test(commit) ||
  !/^[a-f0-9-]{36}$/iu.test(actorUserId)
)
  throw new Error("Publication, commit, or actor identifiers are invalid.");
const deterministic = JSON.parse(
  readFileSync(argument("deterministic-receipt"), "utf8"),
) as Record<string, unknown>;
const launch = JSON.parse(
  readFileSync(argument("evaluation-launch-receipt"), "utf8"),
) as Record<string, unknown>;
const grade = JSON.parse(
  readFileSync(argument("evaluation-grade-receipt"), "utf8"),
) as Record<string, unknown>;
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
const deterministicReceiptHash = createHash("sha256")
  .update(JSON.stringify(canonical(deterministic)))
  .digest("hex");
if (
  deterministic.status !== "passed" ||
  deterministic.publicationHash !== publicationHash ||
  deterministic.commit !== commit
)
  throw new Error(
    "The deterministic receipt does not pass for this exact publication and commit.",
  );
if (
  launch.publicationHash !== publicationHash ||
  launch.commit !== commit ||
  launch.model !== "gpt-5.6-luna" ||
  launch.reasoningEffort !== "max" ||
  launch.fastMode !== false ||
  launch.proMode !== false ||
  launch.processingMode !== "standard" ||
  launch.caseCount !== 200 ||
  launch.deterministicReceiptHash !== deterministicReceiptHash
)
  throw new Error(
    "The evaluation launch receipt violates the locked Luna Max policy.",
  );
if (
  grade.status !== "passed" ||
  grade.caseCount !== 200 ||
  !grade.gates ||
  Object.values(grade.gates as Record<string, unknown>).some(
    (value) => value !== true,
  )
)
  throw new Error(
    "The model evaluation and independent human-review gates have not all passed.",
  );
const gradeBinding = grade.releaseBinding as Record<string, unknown> | null;
const receiptHashKeys = [
  "corpusHash",
  "visibleCorpusHash",
  "holdoutCorpusHash",
  "goldManifestHash",
  "datasetWatermarkHash",
  "deterministicReceiptHash",
] as const;
if (
  !gradeBinding ||
  typeof launch.runId !== "string" ||
  launch.runId.length === 0 ||
  gradeBinding.runId !== launch.runId ||
  gradeBinding.publicationHash !== publicationHash ||
  gradeBinding.commit !== commit ||
  receiptHashKeys.some(
    (key) =>
      typeof launch[key] !== "string" ||
      !/^[a-f0-9]{64}$/u.test(String(launch[key])) ||
      gradeBinding[key] !== launch[key],
  )
) {
  throw new Error(
    "The evaluation grade is not bound to the exact deterministic qualification, launch run, sealed corpus, holdout, deterministic gold, and dataset watermark.",
  );
}
const connectionString = process.env.CONTROL_PLANE_ADMIN_DATABASE_URL?.trim();
if (!connectionString)
  throw new Error("CONTROL_PLANE_ADMIN_DATABASE_URL is required.");
const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE albert_control_migration_owner");
  const publication = await client.query(
    "SELECT 1 FROM control_plane.semantic_v2_publications WHERE publication_hash=$1",
    [publicationHash],
  );
  if (!publication.rows[0])
    throw new Error(
      "The exact semantic publication does not exist in the control plane.",
    );
  const operator = await client.query(
    "SELECT 1 FROM control_plane.internal_operators WHERE user_id=$1::uuid AND enabled AND revoked_at IS NULL",
    [actorUserId],
  );
  if (!operator.rows[0])
    throw new Error(
      "The qualification actor is not an enabled internal operator.",
    );
  await client.query(
    `INSERT INTO control_plane.semantic_v2_activation_qualifications(
       qualification_id,publication_hash,commit_sha,status,deterministic_receipt,model_evaluation_receipt,created_by
     ) VALUES ($1,$2,$3,'passed',$4::jsonb,$5::jsonb,$6::uuid)`,
    [
      ulid(),
      publicationHash,
      commit,
      JSON.stringify(deterministic),
      JSON.stringify({ launch, grade }),
      actorUserId,
    ],
  );
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
process.stdout.write(
  `${JSON.stringify({ status: "passed", publicationHash, commit })}\n`,
);
