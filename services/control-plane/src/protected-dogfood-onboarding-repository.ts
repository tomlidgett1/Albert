import { z } from "zod";
import { signInternalRequest } from "../../../packages/security/src/index.js";
import {
  protectedDogfoodOnboardingReceiptSchema,
  type ProtectedDogfoodOnboardingReceipt,
} from "../../operator-diagnostic/src/contracts.js";
import {
  bootstrapTenant,
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "./web-repository.js";

const journeyIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const claimCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const browserNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const claimSchema = z.object({
  journeyId: journeyIdSchema,
  tenantId: journeyIdSchema,
  claimDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  claimedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  requiresPostClaimLogin: z.literal(true),
}).strict();

export type ProtectedDogfoodOnboardingClaim = z.infer<typeof claimSchema>;

function singleton(value: unknown): unknown {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function safeOperatorDiagnosticEndpoint(path: string): URL {
  const configured = process.env.OPERATOR_DIAGNOSTIC_SERVICE_URL?.trim();
  if (!configured) {
    throw new ControlPlaneError("The protected acceptance service is not configured.", 503);
  }
  try {
    const url = new URL(configured);
    const local = process.env.NODE_ENV !== "production" && url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || url.username || url.password ||
        url.search || url.hash) {
      throw new Error("unsafe operator diagnostic URL");
    }
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}${path}`;
    return url;
  } catch {
    throw new ControlPlaneError("The protected acceptance service URL is invalid.", 503);
  }
}

function operatorDiagnosticSecret(): string {
  const secret = process.env.ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET?.trim() ?? "";
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new ControlPlaneError("The protected acceptance trust boundary is not configured.", 503);
  }
  return secret;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function ensureFreshOwnerTenant(): Promise<Readonly<{ tenantId: string }>> {
  const { user } = await requireUser();
  let context = await currentTenantContext();
  if (!context) {
    const displayName = typeof user.user_metadata.organisation_name === "string"
      ? user.user_metadata.organisation_name.trim()
      : "";
    const timezone = typeof user.user_metadata.timezone === "string"
      ? user.user_metadata.timezone.trim()
      : "Australia/Melbourne";
    if (!displayName) {
      throw new ControlPlaneError(
        "Create this fresh account through the acceptance link with an organisation name.",
        409,
      );
    }
    context = await bootstrapTenant({ displayName, timezone });
  }
  if (context.role !== "owner") {
    throw new ControlPlaneError("The fresh organisation owner must complete acceptance.", 403);
  }
  return Object.freeze({ tenantId: context.tenant_id });
}

export async function claimProtectedDogfoodOnboardingJourney(input: Readonly<{
  journeyId: string;
  code: string;
  browserNonce: string;
  userAgent: string;
}>): Promise<ProtectedDogfoodOnboardingClaim> {
  const parsed = z.object({
    journeyId: journeyIdSchema,
    code: claimCodeSchema,
    browserNonce: browserNonceSchema,
    userAgent: z.string().min(1).max(1_024),
  }).strict().parse(input);
  const { tenantId } = await ensureFreshOwnerTenant();
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc(
    "albert_claim_protected_dogfood_onboarding_journey",
    {
      p_journey_id: parsed.journeyId,
      p_nonce: parsed.code,
      p_browser_nonce_hash: await sha256(parsed.browserNonce),
      p_user_agent_hash: await sha256(parsed.userAgent),
    },
  );
  if (error) {
    const status = error.code === "42501" ? 403
      : error.code === "22023" ? 400
        : error.code === "55000" || error.code === "23505" ? 409
          : error.code === "PGRST202" || error.code === "42883" ? 503
            : 503;
    throw new ControlPlaneError(
      status === 409
        ? "This acceptance journey is unavailable, expired, or belongs to a different fresh account."
        : "The protected onboarding journey could not be claimed.",
      status,
    );
  }
  const claim = claimSchema.safeParse(singleton(data));
  if (!claim.success || claim.data.journeyId !== parsed.journeyId ||
      claim.data.tenantId !== tenantId) {
    throw new ControlPlaneError("The protected onboarding claim returned invalid evidence.", 503);
  }
  return claim.data;
}

export async function completeProtectedDogfoodOnboardingReceipt(input: Readonly<{
  journeyId: string;
  browserNonce: string;
  userAgent: string;
}>): Promise<ProtectedDogfoodOnboardingReceipt> {
  const parsed = z.object({
    journeyId: journeyIdSchema,
    browserNonce: browserNonceSchema,
    userAgent: z.string().min(1).max(1_024),
  }).strict().parse(input);
  const [{ user }, context] = await Promise.all([requireUser(), currentTenantContext()]);
  if (!context || context.role !== "owner") {
    throw new ControlPlaneError("The claimed organisation owner must complete acceptance.", 403);
  }
  const path = "/v1/protected-dogfood/onboarding-receipts" as const;
  const body = JSON.stringify({
    journeyId: parsed.journeyId,
    userId: user.id,
    tenantId: context.tenant_id,
    browserNonceHash: await sha256(parsed.browserNonce),
    userAgentHash: await sha256(parsed.userAgent),
  });
  const headers = await signInternalRequest({
    method: "POST",
    path,
    body,
    secret: operatorDiagnosticSecret(),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  let response: Response;
  try {
    response = await fetch(safeOperatorDiagnosticEndpoint(path), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new ControlPlaneError("The protected browser receipt service is unavailable.", 503);
  } finally {
    clearTimeout(timeout);
  }
  const rawPayload = await response.text();
  if (new TextEncoder().encode(rawPayload).byteLength > 16_384) {
    throw new ControlPlaneError("The protected browser receipt returned an invalid response.", 503);
  }
  let payload: Readonly<{ receipt?: unknown }> | null = null;
  try {
    payload = JSON.parse(rawPayload) as Readonly<{ receipt?: unknown }>;
  } catch {
    // A signed internal service still has to satisfy the bounded response contract.
  }
  if (!response.ok) {
    throw new ControlPlaneError(
      response.status === 503
        ? "Re-login proof is missing, the journey expired, or the receipt was already used."
        : "The protected browser receipt could not be completed.",
      response.status === 400 ? 400 : response.status === 401 ? 503 : 409,
    );
  }
  const receipt = protectedDogfoodOnboardingReceiptSchema.safeParse(payload?.receipt);
  if (!receipt.success || receipt.data.journeyId !== parsed.journeyId ||
      receipt.data.tenantId !== context.tenant_id) {
    throw new ControlPlaneError("The protected browser receipt returned invalid evidence.", 503);
  }
  return receipt.data;
}
