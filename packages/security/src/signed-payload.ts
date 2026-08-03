import { base64UrlToBytes, bytesToBase64Url, decodeUtf8, utf8 } from "./encoding.js";

type TimestampedPayload = Readonly<{
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}>;

async function importHmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  if (utf8(secret).byteLength < 32) {
    throw new Error("Signing secrets must contain at least 32 UTF-8 bytes.");
  }
  return crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

export async function signPayload<T extends TimestampedPayload>(
  payload: T,
  secret: string,
): Promise<string> {
  const encoded = bytesToBase64Url(utf8(JSON.stringify(payload)));
  const key = await importHmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, utf8(encoded));
  return `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifySignedPayload<T extends TimestampedPayload>(
  token: string,
  secret: string,
  options: Readonly<{ now?: number; expectedNonce?: string }> = {},
): Promise<T> {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) throw new Error("Malformed signed payload.");

  const key = await importHmacKey(secret, ["verify"]);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBytes(signature),
    utf8(encoded),
  );
  if (!valid) throw new Error("Invalid signed payload.");

  const parsed = JSON.parse(decodeUtf8(base64UrlToBytes(encoded))) as Partial<TimestampedPayload>;
  const now = options.now ?? Date.now();
  if (
    typeof parsed.issuedAt !== "number" ||
    typeof parsed.expiresAt !== "number" ||
    typeof parsed.nonce !== "string" ||
    parsed.issuedAt > now + 30_000 ||
    parsed.expiresAt <= now
  ) {
    throw new Error("Expired or invalid signed payload.");
  }
  if (options.expectedNonce && parsed.nonce !== options.expectedNonce) {
    throw new Error("Signed payload nonce mismatch.");
  }
  return parsed as T;
}

export function createNonce(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}
