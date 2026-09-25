import { z } from "zod";
import {
  analyticalQueryLogFilterSchema,
  loadAnalyticalQueryLogs,
} from "@/services/control-plane/src/query-log-repository";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const requestSchema = z.object({
  status: analyticalQueryLogFilterSchema.default("failures"),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parsed = requestSchema.safeParse({
      status: url.searchParams.get("status") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return Response.json({ error: "The query log filters are invalid." }, {
        status: 400,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    const logs = await loadAnalyticalQueryLogs(parsed.data);
    return Response.json({ logs }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError ? error.message : "Query logs are unavailable.";
    return Response.json({ error: message }, {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
