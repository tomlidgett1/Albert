const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;

export type EncodedAes256Keyring = Readonly<{
  currentKeyId: string;
  currentKey: string;
  keys: ReadonlyMap<string, string>;
}>;

function canonicalKey(value: string, name: string): string {
  if (!BASE64URL_32_BYTES.test(value)) {
    throw new Error(`${name} must be an unpadded base64url-encoded 256-bit key.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    throw new Error(`${name} must be an unpadded base64url-encoded 256-bit key.`);
  }
  return value;
}

function keyId(value: string, name: string): string {
  if (!KEY_ID_PATTERN.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

/**
 * Load one write/current key plus a bounded set of decrypt-only prior keys.
 * Key values are deliberately never included in error messages.
 */
export function loadEncodedAes256Keyring(input: Readonly<{
  currentKey: string;
  currentKeyId: string;
  previousKeysJson?: string;
  keyName: string;
  keyIdName: string;
  previousKeysName: string;
  maxPreviousKeys?: number;
}>): EncodedAes256Keyring {
  const currentKeyId = keyId(input.currentKeyId.trim(), input.keyIdName);
  const currentKey = canonicalKey(input.currentKey.trim(), input.keyName);
  const keys = new Map<string, string>([[currentKeyId, currentKey]]);
  const keyValues = new Set([currentKey]);
  const previous = input.previousKeysJson?.trim();
  if (previous) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(previous);
    } catch {
      throw new Error(`${input.previousKeysName} must be a JSON object.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${input.previousKeysName} must be a JSON object.`);
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length > (input.maxPreviousKeys ?? 4)) {
      throw new Error(`${input.previousKeysName} contains too many keys.`);
    }
    for (const [candidateId, candidateKey] of entries) {
      const previousKeyId = keyId(candidateId, `Previous ${input.keyName} ID`);
      if (previousKeyId === currentKeyId || typeof candidateKey !== "string") {
        throw new Error(`${input.previousKeysName} must contain distinct string-valued keys.`);
      }
      const encoded = canonicalKey(candidateKey, `Previous ${input.keyName}`);
      if (keyValues.has(encoded)) {
        throw new Error(`${input.previousKeysName} must not reuse key material.`);
      }
      keys.set(previousKeyId, encoded);
      keyValues.add(encoded);
    }
  }
  return Object.freeze({ currentKeyId, currentKey, keys });
}
