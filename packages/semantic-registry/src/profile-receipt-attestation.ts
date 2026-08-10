import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SEMANTIC_PROFILE_RECEIPT_ATTESTATION_DOMAIN =
  "albert-semantic-v2-profile-receipt\0";

export type SemanticProfileReceiptAttestationV2 = Readonly<{
  algorithm: "hmac-sha256";
  keyPurpose: "semantic-profile-v2";
  signature: string;
}>;

function canonicalValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  return value;
}

function canonicalPayload(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function semanticProfileReceiptDigestV2(value: unknown): string {
  return createHash("sha256").update(canonicalPayload(value)).digest("hex");
}

export function attestSemanticProfileReceiptV2(
  unsignedReceipt: Readonly<Record<string, unknown>>,
  secret: string,
): SemanticProfileReceiptAttestationV2 {
  const signature = createHmac("sha256", secret)
    .update(SEMANTIC_PROFILE_RECEIPT_ATTESTATION_DOMAIN)
    .update(canonicalPayload(unsignedReceipt))
    .digest("hex");
  return {
    algorithm: "hmac-sha256",
    keyPurpose: "semantic-profile-v2",
    signature,
  };
}

export function verifySemanticProfileReceiptAttestationV2(
  receipt: Readonly<Record<string, unknown>> & {
    readonly attestation: SemanticProfileReceiptAttestationV2;
  },
  secret: string,
): boolean {
  const { attestation, ...unsignedReceipt } = receipt;
  if (
    attestation.algorithm !== "hmac-sha256" ||
    attestation.keyPurpose !== "semantic-profile-v2" ||
    !/^[a-f0-9]{64}$/u.test(attestation.signature)
  )
    return false;
  const expected = Buffer.from(
    attestSemanticProfileReceiptV2(unsignedReceipt, secret).signature,
    "hex",
  );
  const supplied = Buffer.from(attestation.signature, "hex");
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
