import { z } from "zod";
import { TRANSFORM_CAPACITY_CORPUS_CONTRACT_DIGEST } from "../../../scripts/transform-fleet-capacity-attestation.mjs";

const fullSha = z.string().regex(/^[a-f0-9]{40}$/u);
const appName = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u);

export const capacityAttestationRequestSchema = z.object({
  schemaVersion: z.literal(2),
  authoritySha: fullSha,
  authorityRef: z.string().regex(/^refs\/tags\/albert-release-authority-v[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u),
  candidateSha: fullSha,
  candidateTransformImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  releasePlanDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  workflowRunId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
  workflowRunAttempt: z.number().int().min(1).max(10_000),
  workflowRef: z.string().regex(/^[^\s@]+\/\.github\/workflows\/release-authority\.yml@refs\/tags\/albert-release-authority-v[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u),
  capacityRunId: z.string().regex(/^[1-9][0-9]{0,19}-[1-9][0-9]{0,4}$/u),
  stagingCellId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/u),
  transformApp: appName,
  autoscalerApp: appName,
  requestedFloor: z.number().int().min(2).max(40),
  corpusContractDigest: z.literal(TRANSFORM_CAPACITY_CORPUS_CONTRACT_DIGEST),
  corpusFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().superRefine((value, context) => {
  if (value.transformApp === value.autoscalerApp) {
    context.addIssue({ code: "custom", message: "Capacity transform and autoscaler apps must differ." });
  }
  if (value.capacityRunId !== `${value.workflowRunId}-${value.workflowRunAttempt}`) {
    context.addIssue({ code: "custom", message: "Capacity run id must derive from the workflow run and attempt." });
  }
  if (value.workflowRef !==
      `${value.repository}/.github/workflows/release-authority.yml@${value.authorityRef}`) {
    context.addIssue({
      code: "custom",
      message: "Capacity workflow ref must derive from the repository and immutable authority ref.",
    });
  }
});

export type CapacityAttestationRequest = z.infer<typeof capacityAttestationRequestSchema>;

export type VerifiedGitHubIdentity = Readonly<{
  jti: string;
  repository: string;
  authorityRef: string;
  authoritySha: string;
  runId: string;
  runAttempt: number;
  workflowRef: string;
  environment: string;
}>;

export type CapacityAttestorPolicy = Readonly<{
  repository: string;
  workflowRef: string;
  authorityRef: string;
  authoritySha: string;
  stagingEnvironment: "staging-capacity";
  stagingCellId: string;
  transformApp: string;
  autoscalerApp: string;
  requestedFloor: number;
  corpusFingerprint: string;
}>;

export function enforceCapacityAttestorPolicy(
  request: CapacityAttestationRequest,
  policy: CapacityAttestorPolicy,
): void {
  const expected: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [request.repository, policy.repository, "repository"],
    [request.workflowRef, policy.workflowRef, "workflow ref"],
    [request.authorityRef, policy.authorityRef, "authority ref"],
    [request.authoritySha, policy.authoritySha, "authority SHA"],
    [request.stagingCellId, policy.stagingCellId, "staging cell"],
    [request.transformApp, policy.transformApp, "transform app"],
    [request.autoscalerApp, policy.autoscalerApp, "autoscaler app"],
    [request.requestedFloor, policy.requestedFloor, "requested floor"],
    [request.corpusFingerprint, policy.corpusFingerprint, "corpus fingerprint"],
  ];
  for (const [actual, approved, label] of expected) {
    if (actual !== approved) throw new Error(`Capacity request ${label} is not protected-policy approved.`);
  }
}
