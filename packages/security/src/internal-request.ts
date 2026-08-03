import { bytesToBase64Url, utf8 } from "./encoding.js";

export const INTERNAL_SIGNATURE_HEADER = "x-albert-signature";
export const INTERNAL_TIMESTAMP_HEADER = "x-albert-timestamp";

async function bodyDigest(body: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(body))));
}

async function hmac(message: string, secret: string, usage: "sign" | "verify", signature?: string) {
  if (utf8(secret).byteLength < 32) throw new Error("Internal signing secret is too short.");
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
  if (usage === "sign") {
    const result = await crypto.subtle.sign("HMAC", key, utf8(message));
    return bytesToBase64Url(new Uint8Array(result));
  }
  return crypto.subtle.verify(
    "HMAC",
    key,
    (() => {
      const binary = atob((signature ?? "").replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil((signature ?? "").length / 4) * 4, "="));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    })(),
    utf8(message),
  );
}

function canonicalMessage(method: string, path: string, timestamp: string, digest: string): string {
  return [method.toUpperCase(), path, timestamp, digest].join("\n");
}

export async function signInternalRequest(options: Readonly<{
  method: string;
  path: string;
  body: string;
  secret: string;
  timestamp?: number;
}>): Promise<Readonly<Record<string, string>>> {
  const timestamp = String(options.timestamp ?? Date.now());
  const digest = await bodyDigest(options.body);
  const signature = await hmac(
    canonicalMessage(options.method, options.path, timestamp, digest),
    options.secret,
    "sign",
  );
  return Object.freeze({
    [INTERNAL_TIMESTAMP_HEADER]: timestamp,
    [INTERNAL_SIGNATURE_HEADER]: String(signature),
  });
}

export async function verifyInternalRequest(options: Readonly<{
  method: string;
  path: string;
  body: string;
  secret: string;
  timestamp: string | null;
  signature: string | null;
  now?: number;
  maxSkewMs?: number;
}>): Promise<boolean> {
  if (!options.timestamp || !options.signature) return false;
  const timestamp = Number(options.timestamp);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > (options.maxSkewMs ?? 60_000)) {
    return false;
  }
  const digest = await bodyDigest(options.body);
  return Boolean(await hmac(
    canonicalMessage(options.method, options.path, options.timestamp, digest),
    options.secret,
    "verify",
    options.signature,
  ));
}
