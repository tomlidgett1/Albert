import { ControlPlaneError, listModelUsage } from "@/services/control-plane/src/web-repository";

export async function GET(request: Request) {
  const rawLimit = new URL(request.url).searchParams.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return Response.json({ error: "Limit must be an integer between 1 and 200." }, { status: 400 });
  }
  try {
    return Response.json(await listModelUsage(limit), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Usage history is unavailable." }, { status: 503 });
  }
}
