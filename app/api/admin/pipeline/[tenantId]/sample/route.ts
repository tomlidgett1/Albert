import { z } from "zod";
import { revealOperatorRowSample } from "@/services/control-plane/src/operator-repository";
import { assertSameOriginMutation, readBoundedJsonBody } from "@/services/control-plane/src/request-security";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const tenantSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const inputSchema = z.discriminatedUnion("stage", [
  z.object({
    stage: z.literal("staging"),
    schemaName: z.enum(["source_lightspeed", "source_xero", "source_deputy"]),
    tableName: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/u),
  }).strict(),
  z.object({
    stage: z.literal("canonical"),
    schemaName: z.literal("core"),
    tableName: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/u),
  }).strict(),
  z.object({
    stage: z.literal("marts"),
    schemaName: z.literal("mart"),
    tableName: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/u),
  }).strict(),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  try {
    assertSameOriginMutation(request);
    const tenantId = tenantSchema.safeParse((await params).tenantId);
    if (!tenantId.success) return Response.json({ error: "A valid tenant is required." }, { status: 400 });
    const input = inputSchema.safeParse(await readBoundedJsonBody(request, 1_024));
    if (!input.success) return Response.json({ error: "A valid pipeline table is required." }, { status: 400 });
    const sample = await revealOperatorRowSample({ tenantId: tenantId.data, ...input.data });
    return Response.json({ sample }, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError ? error.message : "The audited row sample is unavailable.";
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
