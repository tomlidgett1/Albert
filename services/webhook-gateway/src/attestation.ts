import { createHash, createHmac, randomBytes } from "node:crypto";

const KEY_ID = /^[a-z][a-z0-9._-]{0,63}$/u;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;

export type WebhookAttestation = Readonly<{
  keyId: string;
  issuedAt: number;
  nonce: string;
  signature: string;
}>;

export type WebhookAttestor = Readonly<{
  keyId: string;
  attest(operation: string, subject: string, document: string): WebhookAttestation;
}>;

export type AttestedWebhookDocument = Readonly<{
  document: string;
  proof: WebhookAttestation;
}>;

export function attestWebhookDocument(
  attestor: WebhookAttestor,
  operation: string,
  subject: string,
  value: Readonly<Record<string, unknown>>,
): AttestedWebhookDocument {
  const document = JSON.stringify(value);
  return Object.freeze({
    document,
    proof: attestor.attest(operation, subject, document),
  });
}

function canonical(
  operation: string,
  subject: string,
  document: string,
  issuedAt: number,
  nonce: string,
): string {
  const documentSha256 = createHash("sha256").update(document, "utf8").digest("hex");
  return ["albert:webhook-attestation:v1", operation, subject, documentSha256, issuedAt, nonce]
    .join("\n");
}

export function createWebhookAttestor(input: Readonly<{
  keyId: string;
  encodedSecret: string;
  now?: () => number;
  nonce?: () => string;
}>): WebhookAttestor {
  if (!KEY_ID.test(input.keyId)) {
    throw new Error("WEBHOOK_ATTESTATION_KEY_ID is invalid.");
  }
  if (!BASE64URL_32_BYTES.test(input.encodedSecret)) {
    throw new Error("WEBHOOK_ATTESTATION_SECRET must encode exactly 32 bytes as unpadded base64url.");
  }
  const secret = Buffer.from(input.encodedSecret, "base64url");
  if (secret.byteLength !== 32 || secret.toString("base64url") !== input.encodedSecret) {
    throw new Error("WEBHOOK_ATTESTATION_SECRET must encode exactly 32 bytes as unpadded base64url.");
  }
  const now = input.now ?? Date.now;
  const newNonce = input.nonce ?? (() => randomBytes(16).toString("base64url"));
  return Object.freeze({
    keyId: input.keyId,
    attest(operation: string, subject: string, document: string): WebhookAttestation {
      if (!/^[a-z][a-z0-9._-]{2,79}$/u.test(operation)) {
        throw new Error("webhook_attestation_operation_invalid");
      }
      if (!subject.trim() || subject.length > 160 || /[\u0000-\u001f\u007f]/u.test(subject)) {
        throw new Error("webhook_attestation_subject_invalid");
      }
      if (!document || Buffer.byteLength(document, "utf8") > 2 * 1024 * 1024) {
        throw new Error("webhook_attestation_document_invalid");
      }
      const issuedAt = Math.floor(now() / 1_000);
      const nonce = newNonce();
      if (!/^[A-Za-z0-9_-]{22}$/u.test(nonce)) {
        throw new Error("webhook_attestation_nonce_invalid");
      }
      const signature = createHmac("sha256", secret)
        .update(canonical(operation, subject, document, issuedAt, nonce), "utf8")
        .digest("hex");
      return Object.freeze({ keyId: input.keyId, issuedAt, nonce, signature });
    },
  });
}
