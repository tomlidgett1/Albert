import { z } from "zod";

export const vendorProviderSchema = z.enum(["lightspeed-r", "lightspeed-x", "xero", "deputy", "square", "shopify", "stripe", "momence", "meta-ads", "google-ads"]);
export type VendorProvider = z.infer<typeof vendorProviderSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const timestamp = z.string().datetime({ offset: true });

export const vendorAttestorClaimSchema = z.object({
  schemaVersion: z.literal(1),
  challengeId: ulid,
  challengeNonceDigest: digest,
  journeyId: ulid,
  candidateSha: z.string().regex(/^[a-f0-9]{40}$/u),
  deploymentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u),
  tenantId: ulid,
  provider: vendorProviderSchema,
  connectionId: ulid,
  connectionGeneration: z.coerce.number().int().positive().safe(),
  selectedExternalAccount: z.string().min(1).max(500),
  selectedExternalAccountDigest: digest,
  credentialReferenceDigest: digest,
  tokenExpiresAt: timestamp,
  issuedAt: timestamp,
  expiresAt: timestamp,
  claimedAt: timestamp,
}).strict();
export type VendorAttestorClaim = z.infer<typeof vendorAttestorClaimSchema>;

export const vendorRelayClaimSchema = z.object({
  schemaVersion: z.literal(1),
  challengeId: ulid,
  challengeNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  challengeNonceDigest: digest,
  provider: vendorProviderSchema,
  tenantId: ulid,
  connectionId: ulid,
  connectionGeneration: z.coerce.number().int().positive().safe(),
  selectedExternalAccount: z.string().min(1).max(500),
  selectedExternalAccountDigest: digest,
  credentialRef: z.string().min(1).max(500),
  credentialReferenceDigest: digest,
  tokenExpiresAt: timestamp,
  expiresAt: timestamp,
}).strict();
export type VendorRelayClaim = z.infer<typeof vendorRelayClaimSchema>;

export const probeEvidenceSchema = z.object({
  endpointId: z.enum([
    "xero.connections.v1",
    "xero.accounting.organisation.v2",
    "lightspeed-r.account.v3",
    "deputy.me.v1",
  ]),
  method: z.literal("GET"),
  statusCode: z.number().int().min(100).max(599),
  headerDigest: digest,
  bodyDigest: digest,
  requestedAt: timestamp,
  respondedAt: timestamp,
}).strict();
export type ProbeEvidence = z.infer<typeof probeEvidenceSchema>;

export const vendorResultBindingSchema = z.object({
  schemaVersion: z.literal(1),
  challengeId: ulid,
  challengeNonceDigest: digest,
  journeyId: ulid,
  candidateSha: z.string().regex(/^[a-f0-9]{40}$/u),
  deploymentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u),
  tenantId: ulid,
  provider: vendorProviderSchema,
  connectionId: ulid,
  connectionGeneration: z.number().int().positive().safe(),
  selectedExternalAccountDigest: digest,
  credentialReferenceDigest: digest,
  probeContractVersion: z.literal("provider-live-identity-v1"),
  status: z.enum(["passed", "failed"]),
  errorCode: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/u).nullable(),
  providerIdentityDigest: digest,
  requestedAt: timestamp,
  respondedAt: timestamp,
  probeEvidence: z.array(probeEvidenceSchema).max(2),
  keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u),
  toolRef: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u),
  buildDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict();
export type VendorResultBinding = z.infer<typeof vendorResultBindingSchema>;

export function resultFromClaim(
  claim: VendorAttestorClaim,
  outcome: Readonly<{
    status: "passed" | "failed";
    errorCode: string | null;
    providerIdentityDigest: string;
    requestedAt: string;
    respondedAt: string;
    probeEvidence: readonly ProbeEvidence[];
  }>,
  producer: Readonly<{ keyId: string; toolRef: string; buildDigest: string }>,
): VendorResultBinding {
  return vendorResultBindingSchema.parse({
    schemaVersion: 1,
    challengeId: claim.challengeId,
    challengeNonceDigest: claim.challengeNonceDigest,
    journeyId: claim.journeyId,
    candidateSha: claim.candidateSha,
    deploymentId: claim.deploymentId,
    tenantId: claim.tenantId,
    provider: claim.provider,
    connectionId: claim.connectionId,
    connectionGeneration: claim.connectionGeneration,
    selectedExternalAccountDigest: claim.selectedExternalAccountDigest,
    credentialReferenceDigest: claim.credentialReferenceDigest,
    probeContractVersion: "provider-live-identity-v1",
    ...outcome,
    probeEvidence: [...outcome.probeEvidence],
    ...producer,
  });
}
