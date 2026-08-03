import { z } from "zod";
import { assertSameOriginMutation } from "@/services/control-plane/src/request-security";
import { requireUser } from "@/services/control-plane/src/web-repository";

const requestSchema = z.object({ confirmation: z.string().min(8).max(200) }).strict();
const statusQuerySchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

function one(value: unknown): unknown {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function rpcStatus(code: string | undefined): number {
  if (code === "42501") return 403;
  if (code === "P0002") return 404;
  if (code === "22023") return 400;
  if (code === "23505") return 409;
  return 503;
}

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const input = requestSchema.safeParse(await request.json());
    if (!input.success) return Response.json({ error: "A valid confirmation is required." }, { status: 400 });
    const { supabase } = await requireUser();
    const { data, error } = await supabase.rpc("albert_request_tenant_deletion", {
      p_confirmation: input.data.confirmation,
    });
    if (error) {
      return Response.json({ error: "The deletion request could not be created.", code: error.code }, {
        status: rpcStatus(error.code),
      });
    }
    return Response.json({ deletion: one(data) }, {
      status: 202,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return Response.json({ error: "The deletion request could not be created." }, { status: 503 });
  }
}

export async function GET(request: Request) {
  try {
    const requestId = statusQuerySchema.safeParse(new URL(request.url).searchParams.get("requestId"));
    if (!requestId.success) return Response.json({ error: "A valid deletion request is required." }, { status: 400 });
    const { supabase } = await requireUser();
    const { data, error } = await supabase.rpc("albert_deletion_status", {
      p_deletion_request_id: requestId.data,
    });
    if (error) return Response.json({ error: "Deletion status is unavailable." }, { status: rpcStatus(error.code) });
    return Response.json({ deletion: data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Deletion status is unavailable." }, { status: 503 });
  }
}
