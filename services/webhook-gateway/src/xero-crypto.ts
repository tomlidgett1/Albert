import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const KEY_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;

export type XeroWebhookInboxKeyring = Readonly<{
  currentKeyId: string;
  currentKey: Uint8Array;
  keys: ReadonlyMap<string, Uint8Array>;
}>;

function decodeKey(value: string, name: string): Uint8Array {
  if (!BASE64URL_32_BYTES.test(value)) {
    throw new Error(`${name} must be an unpadded base64url-encoded 32-byte key.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    throw new Error(`${name} must be an unpadded base64url-encoded 32-byte key.`);
  }
  return new Uint8Array(decoded);
}

function validateKeyId(value: string, name: string): string {
  if (!KEY_ID_PATTERN.test(value)) {
    throw new Error(`${name} must match ${KEY_ID_PATTERN.source}.`);
  }
  return value;
}

/**
 * Previous keys are decrypt-only and make rotation safe across an in-flight
 * inbox. New items always use the separately identified current key.
 */
export function loadXeroWebhookInboxKeyring(
  source: Readonly<Record<string, string | undefined>>,
): XeroWebhookInboxKeyring {
  const currentKeyId = validateKeyId(
    source.WEBHOOK_INBOX_ENCRYPTION_KEY_ID?.trim() ?? "",
    "WEBHOOK_INBOX_ENCRYPTION_KEY_ID",
  );
  const currentKey = decodeKey(
    source.WEBHOOK_INBOX_ENCRYPTION_KEY?.trim() ?? "",
    "WEBHOOK_INBOX_ENCRYPTION_KEY",
  );
  const keys = new Map<string, Uint8Array>([[currentKeyId, currentKey]]);
  const keyValues = new Set([Buffer.from(currentKey).toString("base64url")]);
  const previousValue = source.WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS?.trim();
  if (previousValue) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(previousValue);
    } catch {
      throw new Error("WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS must be a JSON object.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS must be a JSON object.");
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length > 4) {
      throw new Error("WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS may contain at most four keys.");
    }
    for (const [keyId, encoded] of entries) {
      validateKeyId(keyId, "Previous webhook inbox key ID");
      if (keyId === currentKeyId || typeof encoded !== "string") {
        throw new Error("Previous webhook inbox keys must have distinct string values.");
      }
      const decoded = decodeKey(encoded, `Previous webhook inbox key ${keyId}`);
      const canonical = Buffer.from(decoded).toString("base64url");
      if (keyValues.has(canonical)) {
        throw new Error("Previous webhook inbox keys must not reuse key material.");
      }
      keys.set(keyId, decoded);
      keyValues.add(canonical);
    }
  }
  return Object.freeze({ currentKeyId, currentKey, keys });
}

function aad(input: Readonly<{
  inboxId: string;
  keyId: string;
  bodySha256: string;
}>): Buffer {
  return Buffer.from(
    `albert:xero-webhook-inbox:v1:${input.inboxId}:${input.keyId}:${input.bodySha256}`,
    "utf8",
  );
}

export type EncryptedXeroWebhook = Readonly<{
  keyId: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
}>;

export function encryptXeroWebhookBody(input: Readonly<{
  inboxId: string;
  bodySha256: string;
  body: Uint8Array;
  keyring: XeroWebhookInboxKeyring;
}>): EncryptedXeroWebhook {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.keyring.currentKey, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(aad({
    inboxId: input.inboxId,
    keyId: input.keyring.currentKeyId,
    bodySha256: input.bodySha256,
  }));
  const ciphertext = Buffer.concat([cipher.update(input.body), cipher.final()]);
  return Object.freeze({
    keyId: input.keyring.currentKeyId,
    nonce: new Uint8Array(nonce),
    ciphertext: new Uint8Array(ciphertext),
    authTag: new Uint8Array(cipher.getAuthTag()),
  });
}

export class XeroWebhookDecryptionError extends Error {
  constructor(readonly code: "encryption_key_unavailable" | "ciphertext_invalid") {
    super(code);
    this.name = "XeroWebhookDecryptionError";
  }
}

export function decryptXeroWebhookBody(input: Readonly<{
  inboxId: string;
  keyId: string;
  bodySha256: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
  keyring: XeroWebhookInboxKeyring;
}>): Uint8Array {
  const key = input.keyring.keys.get(input.keyId);
  if (!key) throw new XeroWebhookDecryptionError("encryption_key_unavailable");
  if (input.nonce.byteLength !== 12 || input.authTag.byteLength !== 16) {
    throw new XeroWebhookDecryptionError("ciphertext_invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, input.nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(aad(input));
    decipher.setAuthTag(input.authTag);
    const body = Buffer.concat([
      decipher.update(input.ciphertext),
      decipher.final(),
    ]);
    const expected = Buffer.from(input.bodySha256, "hex");
    const actual = createHash("sha256").update(body).digest();
    if (
      expected.byteLength !== actual.byteLength ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new Error("hash_mismatch");
    }
    return new Uint8Array(body);
  } catch (error) {
    if (error instanceof XeroWebhookDecryptionError) throw error;
    throw new XeroWebhookDecryptionError("ciphertext_invalid");
  }
}
