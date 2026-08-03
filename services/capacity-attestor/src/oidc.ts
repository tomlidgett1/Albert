import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import type {
  CapacityAttestationRequest,
  CapacityAttestorPolicy,
  VerifiedGitHubIdentity,
} from "./contracts.js";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "albert-transform-capacity-attestor";
const JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_TOKEN_AGE_SECONDS = 10 * 60;

type JwkSet = Readonly<{ keys: readonly JsonWebKey[] }>;
type JwtObject = Readonly<Record<string, unknown>>;

export class GitHubOidcVerifier {
  private cached: Readonly<{ expiresAt: number; keys: JwkSet }> | undefined;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  async verify(
    token: string,
    request: CapacityAttestationRequest,
    policy: CapacityAttestorPolicy,
  ): Promise<VerifiedGitHubIdentity> {
    if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new Error("GitHub OIDC token is invalid.");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("GitHub OIDC token is malformed.");
    const header = decodeObject(parts[0]!, "header");
    const claims = decodeObject(parts[1]!, "claims");
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(header.kid)) {
      throw new Error("GitHub OIDC signing header is unsupported.");
    }
    const jwks = await this.keys();
    const jwk = jwks.keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
    if (!jwk) {
      this.cached = undefined;
      const refreshed = await this.keys();
      const retry = refreshed.keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
      if (!retry) throw new Error("GitHub OIDC signing key is unknown.");
      this.verifyBytes(parts, retry);
    } else {
      this.verifyBytes(parts, jwk);
    }

    const nowSeconds = Math.floor(this.clock() / 1_000);
    const exp = integerClaim(claims, "exp");
    const iat = integerClaim(claims, "iat");
    const nbf = integerClaim(claims, "nbf");
    if (exp < nowSeconds - 30 || nbf > nowSeconds + 30 || iat > nowSeconds + 30 || iat < nowSeconds - MAX_TOKEN_AGE_SECONDS) {
      throw new Error("GitHub OIDC token is outside its accepted time window.");
    }
    if (stringClaim(claims, "iss") !== ISSUER || !audienceIncludes(claims.aud, AUDIENCE)) {
      throw new Error("GitHub OIDC issuer or audience is invalid.");
    }
    const expectedSubject = `repo:${policy.repository}:environment:${policy.stagingEnvironment}`;
    const required: ReadonlyArray<readonly [string, string, string]> = [
      [stringClaim(claims, "sub"), expectedSubject, "subject"],
      [stringClaim(claims, "repository"), request.repository, "repository"],
      [stringClaim(claims, "sha"), request.candidateSha, "candidate SHA"],
      [stringClaim(claims, "run_id"), request.workflowRunId, "workflow run"],
      [stringClaim(claims, "run_attempt"), String(request.workflowRunAttempt), "workflow attempt"],
      [stringClaim(claims, "workflow_ref"), request.workflowRef, "workflow ref"],
      [stringClaim(claims, "workflow_sha"), request.candidateSha, "workflow SHA"],
      [stringClaim(claims, "ref"), policy.releaseRef, "release ref"],
      [stringClaim(claims, "environment"), policy.stagingEnvironment, "protected environment"],
      [stringClaim(claims, "event_name"), "workflow_dispatch", "workflow event"],
      [stringClaim(claims, "runner_environment"), "github-hosted", "runner environment"],
    ];
    for (const [actual, expected, label] of required) {
      if (actual !== expected) throw new Error(`GitHub OIDC ${label} is not authorized.`);
    }
    const jti = stringClaim(claims, "jti");
    if (!/^[A-Za-z0-9_.:-]{16,200}$/u.test(jti)) throw new Error("GitHub OIDC token id is invalid.");
    return Object.freeze({
      jti,
      repository: request.repository,
      ref: policy.releaseRef,
      sha: request.candidateSha,
      runId: request.workflowRunId,
      runAttempt: request.workflowRunAttempt,
      workflowRef: request.workflowRef,
      environment: policy.stagingEnvironment,
    });
  }

  private verifyBytes(parts: readonly string[], jwk: JsonWebKey): void {
    const verified = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(parts[2]!, "base64url"),
    );
    if (!verified) throw new Error("GitHub OIDC signature is invalid.");
  }

  private async keys(): Promise<JwkSet> {
    const now = this.clock();
    if (this.cached && this.cached.expiresAt > now) return this.cached.keys;
    const response = await this.fetcher(JWKS_URL, {
      headers: { accept: "application/json", "user-agent": "albert-capacity-attestor/1" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`GitHub OIDC JWKS returned ${response.status}.`);
    const body = await response.json() as Partial<JwkSet>;
    if (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 20) {
      throw new Error("GitHub OIDC JWKS is invalid.");
    }
    const keys = Object.freeze({ keys: Object.freeze([...body.keys]) });
    this.cached = Object.freeze({ expiresAt: now + 5 * 60_000, keys });
    return keys;
  }
}

function decodeObject(encoded: string, label: string): JwtObject {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as JwtObject;
  } catch {
    throw new Error(`GitHub OIDC ${label} is malformed.`);
  }
}

function stringClaim(claims: JwtObject, name: string): string {
  const value = claims[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new Error(`GitHub OIDC ${name} claim is invalid.`);
  }
  return value;
}

function integerClaim(claims: JwtObject, name: string): number {
  const value = claims[name];
  if (!Number.isSafeInteger(value)) throw new Error(`GitHub OIDC ${name} claim is invalid.`);
  return value as number;
}

function audienceIncludes(value: unknown, audience: string): boolean {
  return value === audience || (Array.isArray(value) && value.length <= 4 && value.every((item) => typeof item === "string") && value.includes(audience));
}
