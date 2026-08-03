import { z } from "zod";
import {
  answerBlockingQuestion,
  consumeAlbertRateLimit,
  ControlPlaneError,
  currentTenantContext,
  decideIdentityMatch,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("answer_blocking_question"),
    questionId: z.string().trim().min(1).max(100),
    optionId: z.string().trim().min(1).max(100),
  }),
  z.object({
    action: z.literal("identity_decision"),
    taskId: z.string().trim().min(1).max(100),
    decision: z.enum(["proposed", "accepted", "rejected"]),
  }),
]);

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const tenant = await currentTenantContext();
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409 });
    if (!["owner", "manager"].includes(tenant.role)) {
      return Response.json({ error: "Owner or manager access is required." }, { status: 403 });
    }
    const rateLimit = await consumeAlbertRateLimit("review.mutation");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "A valid review action is required." }, { status: 400 });
    if (parsed.data.action === "answer_blocking_question") {
      await answerBlockingQuestion(parsed.data.questionId, parsed.data.optionId);
    } else {
      await decideIdentityMatch(parsed.data.taskId, parsed.data.decision);
    }
    return Response.json({ ok: true });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError ? error.message : "The review action could not be saved.";
    return Response.json({ error: message }, { status });
  }
}
