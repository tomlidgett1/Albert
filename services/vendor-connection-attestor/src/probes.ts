import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import type {
  ProbeEvidence,
  VendorAttestorClaim,
} from "./contracts.js";

const MAX_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 7_500;

export type ProbeHttpResponse = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  requestedAt: string;
  respondedAt: string;
}>;

export type ProbeTransport = (
  url: URL,
  accessToken: Buffer,
  headers?: Readonly<Record<string, string>>,
) => Promise<ProbeHttpResponse>;

export type ProbeOutcome = Readonly<{
  status: "passed" | "failed";
  errorCode: string | null;
  providerIdentityDigest: string;
  requestedAt: string;
  respondedAt: string;
  probeEvidence: readonly ProbeEvidence[];
}>;

const xeroConnectionSchema = z.object({
  id: z.string().min(1).max(100),
  tenantId: z.string().uuid(),
  tenantType: z.string().min(1).max(40),
  tenantName: z.string().max(500).nullable().optional(),
}).passthrough();
const xeroConnectionsSchema = z.array(xeroConnectionSchema).min(1).max(100);
const xeroOrganisationSchema = z.object({
  Organisations: z.array(z.object({
    OrganisationID: z.string().uuid(),
  }).passthrough()).length(1),
}).passthrough();
const lightspeedAccountSchema = z.object({
  Account: z.union([
    z.object({ accountID: z.union([z.string().min(1), z.number().int()]) }).passthrough(),
    z.array(z.object({ accountID: z.union([z.string().min(1), z.number().int()]) }).passthrough()).max(100),
  ]),
}).passthrough();
const deputyMeSchema = z.object({
  Id: z.union([z.string().min(1).max(100), z.number().int().nonnegative()]),
}).passthrough();

class ProbeFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalIdentity(value: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

function evidence(endpointId: ProbeEvidence["endpointId"], response: ProbeHttpResponse): ProbeEvidence {
  const canonicalHeaders = Object.entries(response.headers)
    .filter(([name]) => !["authorization", "cookie", "set-cookie"].includes(name.toLowerCase()))
    .map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}\n`).join("");
  return Object.freeze({
    endpointId,
    method: "GET",
    statusCode: response.statusCode,
    headerDigest: sha256(canonicalHeaders),
    bodyDigest: sha256(response.body),
    requestedAt: response.requestedAt,
    respondedAt: response.respondedAt,
  });
}

function parseJson(response: ProbeHttpResponse): unknown {
  const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/u.test(contentType)) {
    throw new ProbeFailure("response_content_type_invalid", "Vendor identity response is not JSON.");
  }
  if (response.statusCode !== 200) {
    throw new ProbeFailure("vendor_identity_http_error", "Vendor identity endpoint did not return 200.");
  }
  try {
    return JSON.parse(Buffer.from(response.body).toString("utf8"));
  } catch {
    throw new ProbeFailure("response_json_invalid", "Vendor identity response is malformed.");
  }
}

function firstAndLast(items: readonly ProbeEvidence[], fallback: string): readonly [string, string] {
  return [items.at(0)?.requestedAt ?? fallback, items.at(-1)?.respondedAt ?? fallback];
}

export async function runLiveIdentityProbe(
  claim: VendorAttestorClaim,
  accessToken: Buffer,
  transport: ProbeTransport = strictHttpsProbe,
  clock: () => number = Date.now,
): Promise<ProbeOutcome> {
  const observations: ProbeEvidence[] = [];
  const started = new Date(clock()).toISOString();
  let identityDigest = sha256(`failed:${claim.provider}:${claim.challengeId}`);
  try {
    if (claim.provider === "xero") {
      const connectionResponse = await transport(
        fixedUrl("https://api.xero.com/connections"), accessToken,
      );
      observations.push(evidence("xero.connections.v1", connectionResponse));
      let connections: z.infer<typeof xeroConnectionsSchema>;
      try {
        connections = xeroConnectionsSchema.parse(parseJson(connectionResponse));
      } finally {
        connectionResponse.body.fill(0);
      }
      const selected = connections.filter((candidate) =>
        candidate.tenantId === claim.selectedExternalAccount &&
        candidate.tenantType.toUpperCase() === "ORGANISATION");
      if (selected.length !== 1) {
        throw new ProbeFailure("selected_account_mismatch", "Selected Xero tenant is not uniquely connected.");
      }
      const organisationResponse = await transport(
        fixedUrl("https://api.xero.com/api.xro/2.0/Organisation"), accessToken,
        { "xero-tenant-id": claim.selectedExternalAccount },
      );
      observations.push(evidence("xero.accounting.organisation.v2", organisationResponse));
      let organisation: z.infer<typeof xeroOrganisationSchema>;
      try {
        organisation = xeroOrganisationSchema.parse(parseJson(organisationResponse));
      } finally {
        organisationResponse.body.fill(0);
      }
      identityDigest = sha256(canonicalIdentity({
        provider: claim.provider,
        selectedTenantId: claim.selectedExternalAccount,
        connectionId: selected[0]!.id,
        organisationId: organisation.Organisations[0]!.OrganisationID,
      }));
    } else if (claim.provider === "lightspeed-r") {
      const response = await transport(
        fixedUrl("https://api.lightspeedapp.com/API/V3/Account.json"), accessToken,
      );
      observations.push(evidence("lightspeed-r.account.v3", response));
      let parsed: z.infer<typeof lightspeedAccountSchema>;
      try {
        parsed = lightspeedAccountSchema.parse(parseJson(response));
      } finally {
        response.body.fill(0);
      }
      const accounts = Array.isArray(parsed.Account) ? parsed.Account : [parsed.Account];
      const matches = accounts.filter((account) => String(account.accountID) === claim.selectedExternalAccount);
      if (matches.length !== 1) {
        throw new ProbeFailure("selected_account_mismatch", "Selected Lightspeed R account is not uniquely available.");
      }
      identityDigest = sha256(canonicalIdentity({
        provider: claim.provider,
        accountId: String(matches[0]!.accountID),
      }));
    } else {
      const hostname = validatedDeputyHostname(claim.selectedExternalAccount);
      const response = await transport(
        fixedUrl(`https://${hostname}/api/v1/me`, hostname), accessToken,
      );
      observations.push(evidence("deputy.me.v1", response));
      let me: z.infer<typeof deputyMeSchema>;
      try {
        me = deputyMeSchema.parse(parseJson(response));
      } finally {
        response.body.fill(0);
      }
      identityDigest = sha256(canonicalIdentity({
        provider: claim.provider,
        install: hostname,
        userId: String(me.Id),
      }));
    }
    const [requestedAt, respondedAt] = firstAndLast(observations, started);
    return Object.freeze({
      status: "passed", errorCode: null, providerIdentityDigest: identityDigest,
      requestedAt, respondedAt, probeEvidence: Object.freeze(observations),
    });
  } catch (error) {
    const [requestedAt, respondedAt] = firstAndLast(observations, new Date(clock()).toISOString());
    const code = error instanceof ProbeFailure ? error.code
      : error instanceof z.ZodError ? "response_schema_invalid"
      : "vendor_probe_failed";
    return Object.freeze({
      status: "failed", errorCode: code, providerIdentityDigest: identityDigest,
      requestedAt, respondedAt, probeEvidence: Object.freeze(observations),
    });
  }
}

function fixedUrl(value: string, expectedHostname?: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    url.search || url.hash || (expectedHostname && url.hostname !== expectedHostname)
  ) throw new ProbeFailure("probe_url_invalid", "Vendor probe URL is not fixed HTTPS.");
  return url;
}

export function validatedDeputyHostname(value: string): string {
  const hostname = value.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:au|eu|uk|us)\.deputy\.com$/u.test(hostname)) {
    throw new ProbeFailure("deputy_install_invalid", "Deputy install is outside the fixed regional host allowlist.");
  }
  return hostname;
}

export async function strictHttpsProbe(
  url: URL,
  accessToken: Buffer,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Promise<ProbeHttpResponse> {
  if (accessToken.byteLength < 1 || accessToken.byteLength > 65_536 || accessToken.includes(0x0a) || accessToken.includes(0x0d)) {
    throw new ProbeFailure("access_token_invalid", "Access token bytes are invalid.");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const publicAddresses = addresses.filter(({ address }) => !isPrivateOrReserved(address));
  if (publicAddresses.length === 0 || publicAddresses.length !== addresses.length) {
    throw new ProbeFailure("vendor_dns_unsafe", "Vendor hostname did not resolve exclusively to public addresses.");
  }
  const selected = publicAddresses[0]!;
  const authorization = `Bearer ${Buffer.from(accessToken).toString("utf8")}`;
  const requestedAt = new Date().toISOString();
  return await new Promise<ProbeHttpResponse>((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:", hostname: url.hostname, port: 443,
      path: url.pathname, method: "GET", servername: url.hostname,
      rejectUnauthorized: true, minVersion: "TLSv1.2", maxHeaderSize: 16 * 1024,
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
      headers: {
        accept: "application/json",
        authorization,
        "user-agent": "albert-independent-vendor-attestor/1",
        ...additionalHeaders,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          bytes.fill(0); chunks.forEach((item) => item.fill(0));
          response.destroy(new ProbeFailure("response_too_large", "Vendor response exceeded its fixed bound."));
          return;
        }
        chunks.push(bytes);
      });
      response.once("error", reject);
      response.once("end", () => {
        const body = Buffer.concat(chunks, total);
        chunks.forEach((item) => item.fill(0));
        const headers = Object.fromEntries(Object.entries(response.headers)
          .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
          .map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(",") : String(value)]));
        resolve(Object.freeze({
          statusCode: response.statusCode ?? 0,
          headers: Object.freeze(headers), body, requestedAt,
          respondedAt: new Date().toISOString(),
        }));
      });
    });
    request.once("error", reject);
    request.end();
  });
}

export function isPrivateOrReserved(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(normalized)?.[1];
    if (mapped && isIP(mapped) === 4) return isPrivateOrReserved(mapped);
    const mappedHex = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/u.exec(normalized);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1]!, 16);
      const low = Number.parseInt(mappedHex[2]!, 16);
      return isPrivateOrReserved(
        `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`,
      );
    }
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || /^fe[89ab]/u.test(normalized) || normalized.startsWith("ff");
  }
  return true;
}
