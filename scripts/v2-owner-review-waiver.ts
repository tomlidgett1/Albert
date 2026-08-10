import { createHash } from "node:crypto";

export const V2_OWNER_REVIEW_WAIVER_KIND =
  "albert.semantic-v2-owner-review-waiver" as const;

export type V2OwnerReviewWaiverScope =
  | "semantic_publication_tier_1_second_review"
  | "evaluation_subjective_human_review";

export type V2OwnerReviewWaiver = Readonly<{
  schemaVersion: 1;
  kind: typeof V2_OWNER_REVIEW_WAIVER_KIND;
  status: "authorized";
  scope: V2OwnerReviewWaiverScope;
  publicationHash: string;
  draftId?: string;
  draftRevision?: number;
  commit?: string;
  runId?: string;
  reason: string;
  authorizedBy: string;
  createdAt: string;
  waiverDigest: string;
}>;

type OwnerReviewWaiverBinding = Readonly<{
  scope: V2OwnerReviewWaiverScope;
  publicationHash: string;
  draftId?: string;
  draftRevision?: number;
  commit?: string;
  runId?: string;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Owner review waiver must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function v2OwnerReviewWaiverDigest(
  artifactWithoutDigest: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(artifactWithoutDigest)))
    .digest("hex");
}

export function assertV2OwnerReviewWaiver(
  value: unknown,
  binding: OwnerReviewWaiverBinding,
): asserts value is V2OwnerReviewWaiver {
  const waiver = record(value);
  const body = { ...waiver };
  delete body.waiverDigest;
  const publicationScope =
    binding.scope === "semantic_publication_tier_1_second_review";
  const evaluationScope =
    binding.scope === "evaluation_subjective_human_review";
  if (
    waiver.schemaVersion !== 1 ||
    waiver.kind !== V2_OWNER_REVIEW_WAIVER_KIND ||
    waiver.status !== "authorized" ||
    waiver.scope !== binding.scope ||
    waiver.publicationHash !== binding.publicationHash ||
    !SHA256.test(String(waiver.publicationHash ?? "")) ||
    typeof waiver.reason !== "string" ||
    waiver.reason.trim().length < 20 ||
    waiver.reason.length > 2_000 ||
    !UUID.test(String(waiver.authorizedBy ?? "")) ||
    typeof waiver.createdAt !== "string" ||
    !Number.isFinite(Date.parse(waiver.createdAt)) ||
    !SHA256.test(String(waiver.waiverDigest ?? "")) ||
    v2OwnerReviewWaiverDigest(body) !== waiver.waiverDigest ||
    (publicationScope &&
      (!ULID.test(String(waiver.draftId ?? "")) ||
        !Number.isSafeInteger(waiver.draftRevision) ||
        Number(waiver.draftRevision) < 1 ||
        waiver.draftId !== binding.draftId ||
        waiver.draftRevision !== binding.draftRevision ||
        waiver.commit !== undefined ||
        waiver.runId !== undefined)) ||
    (evaluationScope &&
      (!COMMIT.test(String(waiver.commit ?? "")) ||
        typeof waiver.runId !== "string" ||
        waiver.runId.length < 1 ||
        waiver.runId.length > 160 ||
        waiver.commit !== binding.commit ||
        waiver.runId !== binding.runId ||
        waiver.draftId !== undefined ||
        waiver.draftRevision !== undefined))
  ) {
    throw new Error(
      "Owner review waiver is invalid or does not match the exact release binding.",
    );
  }
}
