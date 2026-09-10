import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { assertEmbeddedServiceBuildIdentity } from "../../../packages/config/src/build-identity.js";
import { CubeClient } from "../../../packages/albert-v3/src/cube/client.js";
import {
  ALBERT_OMNI_ANALYSIS_TIMEOUT_MS,
  ALBERT_OMNI_ANALYTICAL_RUNTIME,
  ALBERT_OMNI_RUNTIME,
} from "../../../packages/albert-omni/src/contracts.js";
import { isAlbertModelId, providerForModel } from "../../../packages/shared/src/agent-runtime.js";
import { loadImessageBridgeConfig } from "./config.js";
import { ImessageBridgeHandler } from "./bridge.js";
import { runOwnerAnalysis } from "./analysis.js";
import { AlertsEvaluatorLoop } from "./alerts.js";
import { ScheduledReportScheduler } from "./scheduler.js";
import { DailyBriefLoop } from "./daily-brief.js";
import { DAILY_BRIEF_EFFORT } from "../../recommended-analysis/src/daily-brief.js";

const releaseSha = assertEmbeddedServiceBuildIdentity(process.env);
const config = loadImessageBridgeConfig();
const handler = new ImessageBridgeHandler(config);

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields, at: new Date().toISOString() })}\n`);
}

// Scheduled reports (ADR 0131) run in this process because it alone holds
// the owner session, the Cube signing secret and the Linq token.
const scheduler = config.schedulerEnabled
  ? new ScheduledReportScheduler({
    store: handler.controlPlane,
    sender: handler.linqClient,
    botNumber: config.botNumber,
    runAnalysis: (request) => runOwnerAnalysis({ store: handler.controlPlane, config, log }, request),
    pollMs: config.schedulerPollMs,
    log,
  })
  : null;
handler.setSchedulerStatus(() => scheduler?.status() ?? { enabled: false });

// Heads-up alerts (ADR 0132): deterministic checks over the governed views,
// run here under a short owner turn lease because Cube refuses queries
// without one and only this process may open turns as the owner.
const alerts = config.alertsEnabled
  ? new AlertsEvaluatorLoop({
    store: handler.controlPlane,
    sender: handler.linqClient,
    botNumber: config.botNumber,
    pollMs: config.alertsPollMs,
    quietHours: config.alertsQuietHours,
    log,
    runtimeProfile: {
      provider: isAlbertModelId(config.model) ? providerForModel(config.model) : "anthropic",
      runtime: ALBERT_OMNI_RUNTIME,
      analyticalRuntime: ALBERT_OMNI_ANALYTICAL_RUNTIME,
      model: config.model,
      reasoningEffort: config.effort,
      fastMode: false,
      channel: "imessage",
      analysisTimeoutMs: ALBERT_OMNI_ANALYSIS_TIMEOUT_MS,
      kind: "alerts_evaluation",
    },
    queryLoader: (lease) => {
      const client = new CubeClient({
        apiUrl: config.cubeApiUrl,
        apiSecret: config.cubeApiSecret,
        securityContext: {
          tenant_id: lease.tenantId,
          role: lease.role,
          specialist_agent_id: "general",
          specialist_agent_version: 1,
          conversation_id: lease.conversationId,
          turn_id: lease.turnId,
        },
        // Every governed query lands in the analytical query ledger, as it
        // does for web and iMessage turns; a ledger hiccup never fails a check.
        queryRecorder: {
          start: async (attempt) => {
            await handler.controlPlane.recordQueryAttempt({
              conversationId: lease.conversationId,
              turnId: lease.turnId,
              correlationId: lease.turnId,
              attempt,
            }).catch((error) => log("alerts_query_ledger_failed", { turnId: lease.turnId, phase: "start", error: String(error) }));
          },
          finish: async (outcome) => {
            await handler.controlPlane.recordQueryOutcome(outcome)
              .catch((error) => log("alerts_query_ledger_failed", { turnId: lease.turnId, phase: "finish", error: String(error) }));
          },
        },
      });
      return async (label, query) => {
        const { result } = await client.loadQuery(query, {
          signal: AbortSignal.timeout(100_000),
          audit: { operation: "alerts_evaluation", topic: label },
        });
        if (!result.ok) throw new Error(`${label}: ${result.error}`);
        return result.rows;
      };
    },
  })
  : null;
handler.setAlertsStatus(() => alerts?.status() ?? { enabled: false });

// The rolling daily look (ADR 0137): hourly, a
// Luna Max turn on the Omni harness reads the last 24 hours and writes the
// homepage's "What to look at next". It runs here for the same reason the
// scheduler and alerts do: only this process may run turns as the owner.
const dailyBrief = config.dailyBriefEnabled
  ? new DailyBriefLoop({
    store: handler.controlPlane,
    runAnalysis: (request) => runOwnerAnalysis({ store: handler.controlPlane, config, log }, request),
    model: config.dailyBriefModel,
    effort: DAILY_BRIEF_EFFORT,
    refreshMs: config.dailyBriefRefreshMs,
    pollMs: config.dailyBriefPollMs,
    log,
  })
  : null;
handler.setDailyBriefStatus(() => dailyBrief?.status() ?? { enabled: false });

async function readBody(request: IncomingMessage, maxBytes = 600 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function sendWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, key) => target.setHeader(key, value));
  if (!response.body) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!target.write(Buffer.from(value))) await once(target, "drain");
    }
    target.end();
  } finally {
    reader.releaseLock();
  }
}

const server = createServer((incoming, outgoing) => {
  void (async () => {
    let body: Buffer | undefined;
    try {
      body = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : await readBody(incoming);
    } catch {
      outgoing.statusCode = 413;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ error: { code: "request_too_large", message: "Request too large." } }));
      return;
    }
    const host = incoming.headers.host ?? `127.0.0.1:${config.port}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
      else if (value) headers.set(key, value);
    }
    const request = new Request(`http://${host}${incoming.url ?? "/"}`, {
      method: incoming.method ?? "GET",
      headers,
      ...(body ? { body: new TextDecoder().decode(body) } : {}),
    });
    const response = await handler.handle(request);
    await sendWebResponse(response, outgoing);
  })().catch(() => {
    if (outgoing.headersSent) {
      outgoing.destroy();
      return;
    }
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ error: { code: "internal_error", message: "Internal error." } }));
  });
});

server.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`${JSON.stringify({
    event: "imessage_bridge_started",
    port: config.port,
    buildSha: releaseSha,
    botNumber: config.botNumber,
    model: config.model,
    scheduler: scheduler ? { pollMs: config.schedulerPollMs } : null,
    alerts: alerts ? { pollMs: config.alertsPollMs, quietHours: config.alertsQuietHours } : null,
    dailyBrief: dailyBrief ? { pollMs: config.dailyBriefPollMs, model: config.dailyBriefModel, refreshMs: config.dailyBriefRefreshMs } : null,
  })}\n`);
  scheduler?.start();
  alerts?.start();
  dailyBrief?.start();
});

const shutdown = () => {
  scheduler?.stop();
  alerts?.stop();
  dailyBrief?.stop();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  // An in-flight Omni turn should not block replacement indefinitely; Linq
  // retries undelivered webhooks for ~25 minutes, so a redeploy mid-turn is
  // recovered by the retry rather than by holding the old machine open.
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
