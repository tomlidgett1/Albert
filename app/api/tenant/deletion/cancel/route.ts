import { z } from "zod";
import { assertSameOriginMutation } from "@/services/control-plane/src/request-security";
import { requireUser } from "@/services/control-plane/src/web-repository";

const schema = z.object({
  requestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const input = schema.safeParse(await request.json());
    if (!input.success) return Response.json({ error: "A valid deletion request is required." }, { status: 400 });
    const { supabase } = await requireUser();
    const { error } = await supabase.rpc("albert_cancel_tenant_deletion", {
      p_deletion_request_id: input.data.requestId,
    });
    if (error) {
      const status = error.code === "42501" ? 403 : error.code === "55000" ? 409 : 503;
      return Response.json({ error: "The deletion request could not be cancelled.", code: error.code }, { status });
    }
    return Response.json({ cancelled: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "The deletion request could not be cancelled." }, { status: 503 });
  }
}
