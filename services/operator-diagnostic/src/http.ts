import { z } from "zod";
import { createServiceLogger } from "../../../packages/observability/src/index.js";
import {
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
  verifyInternalRequest,
} from "../../../packages/security/src/index.js";
import {
  operatorDiagnosticRequestSchema,
  operatorDiagnosticSampleSchema,
  protectedDogfoodOnboardingReceiptRequestSchema,
  protectedDogfoodOnboardingReceiptSchema,
  type OperatorDiagnosticGrant,
  type OperatorDiagnosticSample,
  type ProtectedDogfoodOnboardingReceipt,
  type ProtectedDogfoodOnboardingReceiptRequest,
} from "./contracts.js";

export const OPERATOR_DIAGNOSTIC_ROW_SAMPLE_PATH = "/v1/row-samples";
export const PROTECTED_DOGFOOD_ONBOARDING_RECEIPT_PATH =
  "/v1/protected-dogfood/onboarding-receipts";

const logger = createServiceLogger("operator-diagnostic");

export type OperatorDiagnosticControlStore = Readonly<{
  claim(revealId: string): Promise<OperatorDiagnosticGrant>;
  complete(input: Readonly<{
    revealId: string;
    status: "completed" | "failed";
    rowCount: number;
    errorCode?: string;
  }>): Promise<void>;
  completeOnboardingReceipt?(
    input: ProtectedDogfoodOnboardingReceiptRequest,
  ): Promise<ProtectedDogfoodOnboardingReceipt>;
}>;

export type OperatorDiagnosticReadStore = Readonly<{
  sample(grant: OperatorDiagnosticGrant): Promise<OperatorDiagnosticSample>;
}>;

function safeDiagnosticCode(error: unknown): string {
  const value = (error as Readonly<{ diagnosticCode?: unknown; code?: unknown }> | null);
  for (const candidate of [value?.diagnosticCode, value?.code]) {
    if (typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(candidate)) return candidate;
  }
  return "DIAGNOSTIC_QUERY_FAILED";
}

async function persistFailedOutcome(
  store: OperatorDiagnosticControlStore,
  grant: OperatorDiagnosticGrant,
  error: unknown,
): Promise<boolean> {
  const input = Object.freeze({
    revealId: grant.reveal_id,
    status: "failed" as const,
    rowCount: 0,
    errorCode: safeDiagnosticCode(error),
  });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await store.complete(input);
      return true;
    } catch {
      // A committed completion whose acknowledgement was lost will reject the
      // failed outcome as a duplicate. Retrying is still safe and bounded; the
      // append-only database outcome remains authoritative.
    }
  }
  return false;
}

export function createOperatorDiagnosticHttpHandler(options: Readonly<{
  controlStore: OperatorDiagnosticControlStore;
  readStore: OperatorDiagnosticReadStore;
  signingSecret: string;
  clock?: () => number;
  maxClockSkewMs?: number;
}>): (request: Request) => Promise<Response> {
  const clock = options.clock ?? Date.now;
  return async (request: Request): Promise<Response> => {
    const requestId = request.headers.get("x-request-id")?.slice(0, 100);
    if (request.method !== "POST") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use POST." } }, 405, requestId);
    const url = new URL(request.url);
    if (![
      OPERATOR_DIAGNOSTIC_ROW_SAMPLE_PATH,
      PROTECTED_DOGFOOD_ONBOARDING_RECEIPT_PATH,
    ].includes(url.pathname)) {
      return json({ error: { code: "NOT_FOUND", message: "Unknown diagnostic endpoint." } }, 404, requestId);
    }
    const rawBody = await request.text();
    const verified = await verifyInternalRequest({
      method: request.method,
      path: url.pathname,
      body: rawBody,
      secret: options.signingSecret,
      timestamp: request.headers.get(INTERNAL_TIMESTAMP_HEADER),
      signature: request.headers.get(INTERNAL_SIGNATURE_HEADER),
      now: clock(),
      maxSkewMs: options.maxClockSkewMs ?? 60_000,
    });
    if (!verified) return json({ error: { code: "UNAUTHENTICATED", message: "A valid signed diagnostic request is required." } }, 401, requestId);

    if (url.pathname === PROTECTED_DOGFOOD_ONBOARDING_RECEIPT_PATH) {
      try {
        if (!options.controlStore.completeOnboardingReceipt) {
          throw Object.assign(new Error("Protected onboarding receipt is unavailable."), {
            diagnosticCode: "ONBOARDING_RECEIPT_UNAVAILABLE",
          });
        }
        const input = protectedDogfoodOnboardingReceiptRequestSchema.parse(JSON.parse(rawBody));
        const receipt = protectedDogfoodOnboardingReceiptSchema.parse(
          await options.controlStore.completeOnboardingReceipt(input),
        );
        logger.info("protected_dogfood_onboarding_receipt_completed", {
          candidateSha: receipt.candidateSha,
          deploymentId: receipt.deploymentId,
          completedAt: receipt.completedAt,
        }, requestId);
        return json({ receipt }, 200, requestId);
      } catch (error) {
        const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
        logger.error("protected_dogfood_onboarding_receipt_failed", {
          code: invalid ? "INVALID_REQUEST" : safeDiagnosticCode(error),
        }, requestId);
        return json({
          error: {
            code: invalid ? "INVALID_REQUEST" : "DIAGNOSTIC_UNAVAILABLE",
            message: invalid
              ? "The protected onboarding receipt request is invalid."
              : "The protected onboarding receipt could not be completed.",
          },
        }, invalid ? 400 : 503, requestId);
      }
    }

    let grant: OperatorDiagnosticGrant | undefined;
    let completionSucceeded = false;
    try {
      const input = operatorDiagnosticRequestSchema.parse(JSON.parse(rawBody));
      grant = await options.controlStore.claim(input.revealId);
      const sample = operatorDiagnosticSampleSchema.parse(await options.readStore.sample(grant));
      await options.controlStore.complete({
        revealId: grant.reveal_id,
        status: "completed",
        rowCount: sample.rowCount,
      });
      completionSucceeded = true;
      logger.info("row_sample_reveal_completed", { revealId: grant.reveal_id, rowCount: sample.rowCount }, requestId);
      return json({ sample }, 200, requestId);
    } catch (error) {
      if (grant && !completionSucceeded) {
        const terminalOutcomePersisted = await persistFailedOutcome(
          options.controlStore,
          grant,
          error,
        );
        if (!terminalOutcomePersisted) {
          logger.error("row_sample_reveal_outcome_persist_failed", {
            revealId: grant.reveal_id,
            code: safeDiagnosticCode(error),
          }, requestId);
        }
      }
      const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
      logger.error("row_sample_reveal_failed", {
        revealId: grant?.reveal_id ?? null,
        code: invalid ? "INVALID_REQUEST" : safeDiagnosticCode(error),
      }, requestId);
      return json({
        error: {
          code: invalid ? "INVALID_REQUEST" : "DIAGNOSTIC_UNAVAILABLE",
          message: invalid ? "The diagnostic request is invalid." : "The audited row sample could not be revealed.",
        },
      }, invalid ? 400 : 503, requestId);
    }
  };
}

export async function signOperatorDiagnosticRequest(
  rawBody: string,
  secret: string,
  timestamp?: number,
): Promise<Readonly<Record<string, string>>> {
  return signInternalRequest({
    method: "POST",
    path: OPERATOR_DIAGNOSTIC_ROW_SAMPLE_PATH,
    body: rawBody,
    secret,
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}

export async function signProtectedDogfoodOnboardingRequest(
  path: typeof PROTECTED_DOGFOOD_ONBOARDING_RECEIPT_PATH,
  rawBody: string,
  secret: string,
  timestamp?: number,
): Promise<Readonly<Record<string, string>>> {
  return signInternalRequest({
    method: "POST",
    path,
    body: rawBody,
    secret,
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}

function json(value: unknown, status: number, requestId?: string | null): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
  });
}
