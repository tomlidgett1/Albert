import { createHmac } from "node:crypto";
import type { CubeSecurityContext } from "./types.js";

/**
 * Signs the HS256 JWT Cube expects on every request. The token carries the
 * authenticated tenant's security context; `cube.js` queryRewrite refuses any
 * request whose token lacks a tenant claim, so a client that cannot sign
 * cannot query.
 */
export function signCubeJwt(input: Readonly<{
  secret: string;
  securityContext: CubeSecurityContext;
  expiresInSeconds?: number;
}>): string {
  const secret = input.secret.trim();
  if (!secret) throw new Error("A Cube API secret is required to sign requests.");
  const tenantId = input.securityContext.tenant_id?.trim();
  if (!tenantId) throw new Error("A tenant id is required for the Cube security context.");

  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    tenant_id: tenantId,
    ...(input.securityContext.role ? { role: input.securityContext.role } : {}),
    ...(input.securityContext.specialist_agent_id
      ? {
        specialist_agent_id: input.securityContext.specialist_agent_id,
        specialist_agent_version: input.securityContext.specialist_agent_version,
      }
      : {}),
    ...(input.securityContext.conversation_id
      ? {
        conversation_id: input.securityContext.conversation_id,
        turn_id: input.securityContext.turn_id,
      }
      : {
        dashboard_tile_id: input.securityContext.dashboard_tile_id,
        dashboard_refresh_lease_id: input.securityContext.dashboard_refresh_lease_id,
      }),
    exp: Math.floor(Date.now() / 1000) + (input.expiresInSeconds ?? 3_600),
  });
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}
