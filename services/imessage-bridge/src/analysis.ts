import { ulid } from "ulid";
import { signCubeJwt } from "../../../packages/albert-v3/src/cube/jwt.js";
import {
  ALBERT_OMNI_ANALYSIS_TIMEOUT_MS,
  ALBERT_OMNI_ANALYTICAL_RUNTIME,
  ALBERT_OMNI_MESSAGE_MAX_CHARS,
  ALBERT_OMNI_PROTOCOL_VERSION,
  ALBERT_OMNI_RUNTIME,
  type OmniServiceTurn,
} from "../../../packages/albert-omni/src/contracts.js";
import { OmniRuntimeServiceClient } from "../../../packages/albert-omni/src/service-client.js";
import { pairDerivedTableEvent } from "../../../packages/albert-omni/src/pivot.js";
import type { OmniTraceEventInput } from "../../../packages/albert-omni/src/runtime.js";
import {
  codexSocialProvenance,
  codexSocialReply,
  detectCodexSocialMessage,
} from "../../../packages/albert-codex/src/social.js";
import { isAlbertModelId, providerForModel } from "../../../packages/shared/src/agent-runtime.js";
import type { ImessageBridgeConfig } from "./config.js";
import { createPersistingEmitter, type OwnerControlPlane } from "./owner-session.js";

/**
 * One Omni analysis run as the owner, persisted as a governed conversation
 * turn exactly as the web route would persist it: begin the turn lease,
 * stream the runtime's trace events into the answer log (pairing table
 * events with their queries so dashboard replays stay valid), finalize the
 * turn and return the answer text. Shared by the inbound iMessage path
 * (a reply into a Linq chat) and the scheduler (a report texted to an
 * enrolled number), so both deliver the same analysis contract.
 */

const LEASE_RENEWAL_INTERVAL_MS = 120_000;
const TURN_TIMEOUT_MS = ALBERT_OMNI_ANALYSIS_TIMEOUT_MS + 60_000;

export type OwnerAnalysisRequest = Readonly<{
  question: string;
  /** Continue this standing conversation; omitted starts a new one. */
  conversationId?: string;
  /** Title assigned to a newly created conversation. */
  newConversationTitle?: string;
  /** Model and effort for this run; the bridge's locked haiku/max when omitted. */
  model?: string;
  effort?: ImessageBridgeConfig["effort"];
  /** Stored on the turn's runtime profile so the ledger can tell what kind of turn it was. */
  kind?: string;
  /** Delivery channel: iMessage bubbles by default; `null` asks for the in-app answer contract. */
  channel?: "imessage" | null;
}>;

export type OwnerAnalysisResult = Readonly<{
  conversationId: string;
  turnId: string;
  answerText: string;
  answerState: string;
  clarification: string;
  /** The answer's follow-up questions, as the harness extracted them. */
  followUps: readonly string[];
}>;

export type OwnerAnalysisConfig = Pick<
  ImessageBridgeConfig,
  "model" | "effort" | "cubeApiSecret" | "runtimeServiceUrl" | "runtimeSigningSecret"
>;

export type AnalysisLogger = (event: string, fields?: Record<string, unknown>) => void;

export async function runOwnerAnalysis(
  deps: Readonly<{ store: OwnerControlPlane; config: OwnerAnalysisConfig; log: AnalysisLogger }>,
  request: OwnerAnalysisRequest,
): Promise<OwnerAnalysisResult> {
  const { store, config, log } = deps;
  const question = request.question.slice(0, ALBERT_OMNI_MESSAGE_MAX_CHARS);
  const model = request.model ?? config.model;
  const effort = request.effort ?? config.effort;
  const channel = request.channel === undefined ? "imessage" : request.channel;
  const tenant = await store.tenantContext();
  const existingConversationId = request.conversationId;
  const turnId = ulid();
  const runtimeProfile = {
    provider: isAlbertModelId(model) ? providerForModel(model) : "anthropic",
    runtime: ALBERT_OMNI_RUNTIME,
    analyticalRuntime: ALBERT_OMNI_ANALYTICAL_RUNTIME,
    model,
    reasoningEffort: effort,
    fastMode: false,
    channel: channel ?? "web",
    analysisTimeoutMs: ALBERT_OMNI_ANALYSIS_TIMEOUT_MS,
    ...(request.kind ? { kind: request.kind } : {}),
  } as const;
  let conversationId: string;
  try {
    conversationId = await store.beginTurn({
      ...(existingConversationId ? { conversationId: existingConversationId } : {}),
      turnId,
      message: question,
      runtimeProfile,
    });
  } catch (error) {
    // A running turn from a crashed process holds the conversation; this
    // process is not running one (the caller gates that), so release and
    // retry once before giving up.
    if (existingConversationId && /running|55000/iu.test(error instanceof Error ? error.message : "")) {
      await store.releaseRunningTurns(existingConversationId);
      conversationId = await store.beginTurn({
        conversationId: existingConversationId,
        turnId,
        message: question,
        runtimeProfile,
      });
    } else {
      throw error;
    }
  }
  if (!existingConversationId && request.newConversationTitle) {
    await store.assignConversationTitle(conversationId, request.newConversationTitle).catch(() => undefined);
  }

  const emitter = createPersistingEmitter({
    store,
    conversationId,
    turnId,
    onPersistError: (error, event) => log("imessage_trace_persist_failed", {
      conversationId,
      turnId,
      eventType: (event as { type?: string }).type,
      error: error instanceof Error ? error.message : String(error),
    }),
  });

  const social = detectCodexSocialMessage(question);
  if (social) {
    const reply = codexSocialReply(social, question);
    await emitter.emit({
      type: "answer",
      status: "complete",
      state: "Verified",
      text: reply.text,
      provenance: codexSocialProvenance(),
      followUps: [],
      presentedResultIds: [],
      claims: [],
    });
    await emitter.drain();
    await store.failTurn(conversationId, turnId, "albert_omni_social_answered");
    return Object.freeze({ conversationId, turnId, answerText: reply.text, answerState: "Verified", clarification: "", followUps: [] });
  }

  const [priorConversation, routing, businessContext] = await Promise.all([
    existingConversationId
      ? store.priorConversation(conversationId).catch(() => [] as const)
      : Promise.resolve([] as const),
    store.connectorRouting(),
    store.businessContext(),
  ]);
  // The current turn's user message is already stored; the model context
  // RPC returns finished turns only, so no self-echo trim is needed.
  const cubeBearer = signCubeJwt({
    secret: config.cubeApiSecret,
    expiresInSeconds: 2_700,
    securityContext: {
      tenant_id: tenant.tenant_id,
      role: tenant.role,
      specialist_agent_id: "general",
      specialist_agent_version: 1,
      conversation_id: conversationId,
      turn_id: turnId,
    },
  });
  const turn: OmniServiceTurn = {
    protocolVersion: ALBERT_OMNI_PROTOCOL_VERSION,
    requestId: ulid(),
    tenantId: tenant.tenant_id,
    actorId: await store.ownerUserId(),
    role: tenant.role,
    conversationId,
    turnId,
    message: question,
    priorConversation: [...priorConversation],
    activeConnectors: [...routing.activeConnectors],
    connectorFreshness: routing.freshness.map((entry) => ({
      connector: entry.connector,
      domain: entry.domain,
      dataThrough: entry.dataThrough,
    })),
    ...(businessContext ? { businessContext } : {}),
    timezone: tenant.timezone,
    ownerName: "Tom",
    organisationName: tenant.tenant_name.slice(0, 160),
    cubeBearer,
    model,
    effort,
    fastMode: false,
    ...(channel ? { channel } : {}),
  };

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error("The analysis timed out.")), TURN_TIMEOUT_MS);
  const leaseRenewal = setInterval(() => {
    void store.renewTurnLease(turnId).catch(() => undefined);
  }, LEASE_RENEWAL_INTERVAL_MS);
  let answerText = "";
  let answerState = "";
  let clarification = "";
  let followUps: readonly string[] = [];
  // Replayable tables arrive with an empty dashboardReplay.queryEventId and
  // a resultId pairing them to their query event; the caller stamps event
  // ids, so the pairing happens here exactly as in the web route — an
  // unpairable reference is stripped so a broken replay ref never persists.
  const queryEventIdByResultId = new Map<string, string>();
  const tableEventIdByResultId = new Map<string, string>();
  try {
    const client = new OmniRuntimeServiceClient(config.runtimeServiceUrl, config.runtimeSigningSecret);
    const result = await client.runTurn(
      turn,
      async (event: OmniTraceEventInput) => {
        if (event.type === "answer") {
          answerText = event.text;
          answerState = event.state;
          followUps = [...((event as { followUps?: readonly string[] }).followUps ?? [])];
        } else if (event.type === "clarification") {
          clarification = [
            event.question,
            ...event.options.map((option, index) => `${index + 1}. ${option.label}`),
          ].join("\n");
          answerState = "Clarification";
        }
        let outbound = event as unknown as Record<string, unknown>;
        const replay = (outbound as {
          type?: string;
          resultId?: string;
          dashboardReplay?: { kind?: string; queryEventId?: string };
        });
        if (replay.type === "table" && replay.dashboardReplay?.kind === "cube_v3" && !replay.dashboardReplay.queryEventId) {
          const queryEventId = replay.resultId ? queryEventIdByResultId.get(replay.resultId) : undefined;
          if (queryEventId) {
            outbound = { ...outbound, dashboardReplay: { ...replay.dashboardReplay, queryEventId } };
          } else {
            outbound = { ...outbound };
            delete outbound.dashboardReplay;
          }
        }
        if (replay.type === "table" && replay.dashboardReplay?.kind === "derived_v1") {
          const paired = pairDerivedTableEvent(
            outbound as never,
            tableEventIdByResultId,
          );
          if (paired) {
            outbound = { ...outbound, ...paired };
          } else {
            outbound = { ...outbound };
            delete outbound.dashboardReplay;
            delete outbound.dashboardDerivation;
          }
        }
        const stamped = await emitter.emit(outbound) as unknown as { type?: string; resultId?: string; id?: string };
        if (stamped.type === "query" && stamped.resultId && stamped.id) {
          queryEventIdByResultId.set(stamped.resultId, stamped.id);
        }
        if (stamped.type === "table" && stamped.resultId && stamped.id) {
          tableEventIdByResultId.set(stamped.resultId, stamped.id);
        }
      },
      abort.signal,
      // Every governed query attempt and outcome lands in the analytical
      // query ledger, as it does for web turns; a ledger hiccup is logged
      // rather than allowed to fail the owner's reply.
      async (event) => {
        try {
          if (event.phase === "start") {
            await store.recordQueryAttempt({
              conversationId: turn.conversationId,
              turnId: turn.turnId,
              correlationId: turn.requestId,
              attempt: event.attempt,
            });
          } else {
            await store.recordQueryOutcome(event.outcome);
          }
        } catch (error) {
          log("imessage_query_ledger_failed", {
            turnId: turn.turnId,
            phase: event.phase,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    if (!answerState) answerState = result.answerState;
    await emitter.drain();
    await store.failTurn(
      conversationId,
      turnId,
      answerState === "Unavailable" ? "albert_omni_unavailable" : "albert_omni_answered",
    );
  } catch (error) {
    await emitter.emit({
      type: "error",
      status: "error",
      message: "The analysis could not be completed.",
      recoverable: true,
    }).catch(() => undefined);
    await emitter.drain().catch(() => undefined);
    await store.failTurn(conversationId, turnId, "omni_runtime_failure").catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(leaseRenewal);
  }

  return Object.freeze({ conversationId, turnId, answerText, answerState, clarification, followUps });
}
