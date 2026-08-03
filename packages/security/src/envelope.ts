import { base64UrlToBytes, bytesToBase64Url, decodeUtf8, utf8 } from "./encoding.js";

export type SealedSecret = Readonly<{
  version: 1;
  algorithm: "A256GCM";
  keyId: string;
  iv: string;
  ciphertext: string;
}>;

async function importAesKey(encodedKey: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(encodedKey);
  if (bytes.byteLength !== 32) {
    throw new Error("The encryption key must decode to exactly 32 bytes.");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages);
}

/** AES-256-GCM envelope suitable for worker-only OAuth credential material. */
export async function sealSecret(options: Readonly<{
  plaintext: string;
  encodedKey: string;
  keyId: string;
  associatedData: string;
}>): Promise<SealedSecret> {
  if (!options.plaintext) throw new Error("A secret value is required.");
  if (!options.keyId.trim()) throw new Error("A key identifier is required.");
  if (!options.associatedData.trim()) throw new Error("Associated data is required.");

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(options.encodedKey, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(options.associatedData), tagLength: 128 },
    key,
    utf8(options.plaintext),
  );

  return Object.freeze({
    version: 1,
    algorithm: "A256GCM",
    keyId: options.keyId,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  });
}

export async function openSecret(options: Readonly<{
  envelope: SealedSecret;
  encodedKey: string;
  associatedData: string;
}>): Promise<string> {
  if (options.envelope.version !== 1 || options.envelope.algorithm !== "A256GCM") {
    throw new Error("Unsupported credential envelope.");
  }
  const key = await importAesKey(options.encodedKey, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(options.envelope.iv),
      additionalData: utf8(options.associatedData),
      tagLength: 128,
    },
    key,
    base64UrlToBytes(options.envelope.ciphertext),
  );
  return decodeUtf8(plaintext);
}
