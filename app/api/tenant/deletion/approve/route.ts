import { z } from "zod";
import { assertSameOriginMutation } from "@/services/control-plane/src/request-security";
import { requireUser } from "@/services/control-plane/src/web-repository";

const schema = z.object({
  requestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  confirmation: z.string().min(7).max(200),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const input = schema.safeParse(await request.json());
    if (!input.success) return Response.json({ error: "A valid approval is required." }, { status: 400 });
    const { supabase } = await requireUser();
    const { data, error } = await supabase.rpc("albert_approve_tenant_deletion", {
      p_deletion_request_id: input.data.requestId,
      p_confirmation: input.data.confirmation,
    });
    if (error) {
      const status = error.code === "42501" ? 403 : error.code === "22023" ? 400 : error.code === "55000" ? 409 : 503;
      return Response.json({ error: "The deletion request could not be approved.", code: error.code }, { status });
    }
    return Response.json({ deletion: Array.isArray(data) ? data[0] ?? null : data }, {
      status: 202,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return Response.json({ error: "The deletion request could not be approved." }, { status: 503 });
  }
}
