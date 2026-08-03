import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../../scripts/transform-fleet-capacity-attestation.mjs";
import { CAPACITY_ATTESTATION_POLL_AFTER_SECONDS } from "../../../scripts/capacity-attestation-timing.mjs";
import {
  capacityAttestationRequestSchema,
  enforceCapacityAttestorPolicy,
  type CapacityAttestorPolicy,
} from "./contracts.js";
import type { GitHubOidcVerifier } from "./oidc.js";
import type {
  CapacityCollectorPersistence,
  TransformFleetCapacityCollector,
} from "./collector.js";
import type { PostgresCapacityAttestationStore } from "./store.js";

export function createCapacityAttestorHttpHandler(options: Readonly<{
  policy: CapacityAttestorPolicy;
  oidc: Pick<GitHubOidcVerifier, "verify">;
  collector: Pick<TransformFleetCapacityCollector, "collect">;
  store: Pick<PostgresCapacityAttestationStore, "reserve" | "checkpoint" | "complete" | "fail">;
}>): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = safeRequestId(request.headers.get("x-request-id"));
    const url = new URL(request.url);
    if (request.method !== "POST") return json(405, "METHOD_NOT_ALLOWED", "Use POST.", requestId);
    if (url.pathname !== "/v1/transform-capacity-attestations") {
      return json(404, "NOT_FOUND", "Unknown attestation endpoint.", requestId);
    }
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return json(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.", requestId);
    }
    const authorization = request.headers.get("authorization") ?? "";
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/u.exec(authorization)?.[1];
    if (!token) return json(401, "UNAUTHENTICATED", "A GitHub OIDC bearer token is required.", requestId);

    let input;
    try {
      input = capacityAttestationRequestSchema.parse(JSON.parse(await request.text()));
      enforceCapacityAttestorPolicy(input, options.policy);
    } catch (error) {
      const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
      return json(invalid ? 400 : 403, invalid ? "INVALID_REQUEST" : "POLICY_DENIED",
        invalid ? "Capacity attestation request is invalid." : "Capacity attestation request is not approved.", requestId);
    }
    let identity;
    try {
      identity = await options.oidc.verify(token, input, options.policy);
    } catch {
      return json(401, "UNAUTHENTICATED", "GitHub OIDC identity is not authorized.", requestId);
    }
    const key = {
      repository: input.repository,
      workflowRunId: input.workflowRunId,
      workflowRunAttempt: input.workflowRunAttempt,
      candidateSha: input.candidateSha,
    };
    const requestDigest = createHash("sha256").update(canonicalJson(input)).digest("hex");
    let reservation;
    try {
      reservation = await options.store.reserve(key, identity.jti, requestDigest);
    } catch {
      return json(409, "RUN_IDENTITY_CONFLICT", "Capacity run identity conflicts with prior evidence.", requestId);
    }
    if (reservation.status === "completed") return envelope(reservation.envelope, requestId);
    if (reservation.status === "failed") {
      return json(503, "CAPACITY_NOT_ATTESTED", "Independent capacity requirements were not satisfied.", requestId);
    }
    if (reservation.status === "busy") return pending(input, requestDigest, requestId);
    const persistence: CapacityCollectorPersistence = Object.freeze({
      checkpoint: reservation.checkpoint,
      save: async (checkpoint) => {
        await options.store.checkpoint(key, reservation.leaseToken, checkpoint);
      },
    });
    void options.collector.collect(input, persistence).then(async (result) => {
      await options.store.complete(key, reservation.leaseToken, result);
    }).catch(async (error) => {
      await options.store.fail(key, reservation.leaseToken, safeErrorCode(error)).catch(() => undefined);
    });
    return pending(input, requestDigest, requestId);
  };
}

function envelope(value: Readonly<Record<string, unknown>>, requestId: string | undefined): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: securityHeaders(requestId) });
}

function pending(
  input: Readonly<{ repository: string; workflowRunId: string; workflowRunAttempt: number }>,
  requestDigest: string,
  requestId: string | undefined,
): Response {
  const attestationId = createHash("sha256").update(canonicalJson({
    repository: input.repository,
    workflowRunId: input.workflowRunId,
    workflowRunAttempt: input.workflowRunAttempt,
    requestDigest,
  })).digest("hex");
  return new Response(JSON.stringify({
    schemaVersion: 1,
    status: "pending",
    attestationId,
    pollAfterSeconds: CAPACITY_ATTESTATION_POLL_AFTER_SECONDS,
  }), {
    status: 202,
    headers: {
      ...securityHeaders(requestId),
      "retry-after": String(CAPACITY_ATTESTATION_POLL_AFTER_SECONDS),
    },
  });
}

function json(
  status: number,
  code: string,
  message: string,
  requestId?: string,
  retryAfter?: number,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { ...securityHeaders(requestId), ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) },
  });
}

function securityHeaders(requestId?: string): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...(requestId ? { "x-request-id": requestId } : {}),
  };
}

function safeRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9_.:-]{1,100}$/u.test(value) ? value : undefined;
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "unknown";
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
