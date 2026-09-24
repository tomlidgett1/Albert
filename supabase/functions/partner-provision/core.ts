/**
 * Pure pieces of the partner provisioning function (ADR 0151): platform-key
 * parsing and matching, request validation, and the deterministic identities
 * a provisioned store gets. No Deno or npm imports, so the contract tests run
 * them under Node.
 */

export type PartnerPlatform = Readonly<{
  /** The partner product, e.g. "yellow-jersey". Every client it creates carries it. */
  partner: string;
  /** Lowercase hex SHA-256 of the platform key. */
  keySha256: string;
  enabled: boolean;
}>;

export type ProvisionRequest = Readonly<{
  action: "provision";
  /** The partner's id for the account (Yellow Jersey: the store owner's user id). */
  accountRef: string;
  displayName: string;
  timezone: string;
  /** SHA-256 of the partner key the partner generated and keeps. */
  keySha256: string;
  /** The partner refreshes the vendor grants and brokers access tokens. */
  tokenBroker: boolean;
}>;

export type DisableRequest = Readonly<{ action: "disable"; accountRef: string }>;

export type PlatformRequest = ProvisionRequest | DisableRequest;

export const PLATFORM_KEY_PATTERN = /^albert_pp_[A-Za-z0-9_-]{43}$/u;
export const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/u;
export const ACCOUNT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+/-]{1,63}$/u;
/** Fixed namespace for acting-member ids (UUIDv5), so a retry finds the same member. */
const ACTING_MEMBER_NAMESPACE = "0f3b9d0e-5a51-4d8e-9a7c-1d2b8c7e6f15";

export class PlatformConfigurationError extends Error {}

export function parsePlatforms(raw: string | undefined): readonly PartnerPlatform[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PlatformConfigurationError("ALBERT_PARTNER_PLATFORMS is not valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new PlatformConfigurationError("ALBERT_PARTNER_PLATFORMS must be an array.");
  const platforms = parsed.map((value, index) => {
    const entry = value as Record<string, unknown> | null;
    const fail = (field: string): never => {
      throw new PlatformConfigurationError(`ALBERT_PARTNER_PLATFORMS[${index}].${field} is invalid.`);
    };
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("entry");
    const { partner, keySha256, enabled } = entry!;
    if (typeof partner !== "string" || !CLIENT_ID_PATTERN.test(partner)) fail("partner");
    if (typeof keySha256 !== "string" || !HEX_SHA256_PATTERN.test(keySha256)) fail("keySha256");
    if (typeof enabled !== "boolean") fail("enabled");
    return Object.freeze({ partner: partner as string, keySha256: keySha256 as string, enabled: enabled as boolean });
  });
  if (new Set(platforms.map(({ keySha256 }) => keySha256)).size !== platforms.length) {
    throw new PlatformConfigurationError("ALBERT_PARTNER_PLATFORMS reuses a key digest.");
  }
  return platforms;
}

export function bearerKey(authorization: string | null, pattern: RegExp): string | null {
  const match = /^Bearer (\S+)$/iu.exec(authorization?.trim() ?? "");
  const key = match?.[1] ?? "";
  return pattern.test(key) ? key : null;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two equal-length lowercase hex digests. */
export function digestsEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** Every entry is compared so the match position never shapes the timing. */
export function matchPlatform(platforms: readonly PartnerPlatform[], digest: string): PartnerPlatform | undefined {
  let found: PartnerPlatform | undefined;
  for (const candidate of platforms) {
    if (digestsEqual(candidate.keySha256, digest) && !found) found = candidate;
  }
  return found;
}

export function parsePlatformRequest(value: unknown): PlatformRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const accountRef = typeof body.accountRef === "string" ? body.accountRef.trim() : "";
  if (!ACCOUNT_REF_PATTERN.test(accountRef)) return null;
  if (body.action === "disable") return Object.freeze({ action: "disable", accountRef });
  if (body.action !== "provision") return null;
  const displayName = typeof body.displayName === "string" ? body.displayName.replace(/\s+/gu, " ").trim() : "";
  const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "";
  const keySha256 = typeof body.keySha256 === "string" ? body.keySha256.trim() : "";
  if (displayName.length < 1 || displayName.length > 120) return null;
  if (!TIMEZONE_PATTERN.test(timezone)) return null;
  if (!HEX_SHA256_PATTERN.test(keySha256)) return null;
  if (body.tokenBroker !== undefined && typeof body.tokenBroker !== "boolean") return null;
  return Object.freeze({
    action: "provision",
    accountRef,
    displayName,
    timezone,
    keySha256,
    tokenBroker: body.tokenBroker === true,
  });
}

/** `yellow-jersey` + a UUID account ref → `yellow-jersey-3acef09d8b2846e8a0c345ce59c61972`. */
export function clientIdFor(partner: string, accountRef: string): string {
  const compact = accountRef.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const clientId = `${partner}-${compact}`.slice(0, 64).replace(/-+$/u, "");
  if (!CLIENT_ID_PATTERN.test(clientId)) throw new Error("client id could not be derived");
  return clientId;
}

/**
 * The acting member's sign-in address. `.invalid` is reserved (RFC 2606), so
 * nothing can ever be delivered to it; Albert only mints sessions for it
 * through the admin API.
 */
export function actingMemberEmail(clientId: string): string {
  return `${clientId}@partner-members.albert.invalid`;
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/gu, "");
  return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

/** RFC 4122 version 5 (SHA-1, namespaced) UUID. */
export async function uuidV5(namespace: string, name: string): Promise<string> {
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  input.set(uuidBytes(namespace), 0);
  input.set(nameBytes, 16);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Deterministic, so a retried provisioning reuses the member it already created. */
export function actingMemberId(partner: string, accountRef: string): Promise<string> {
  return uuidV5(ACTING_MEMBER_NAMESPACE, `${partner}:${accountRef}`);
}
