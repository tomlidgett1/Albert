import OpenAI from "openai";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentSession } from "openai/resources/beta/agents/agents";
import { MANAGED_SESSION_IDLE_MS, MANAGED_SESSION_NAMESPACE } from "./session-state.js";

export function isExpiredManagedSession(session: AgentSession, now: number): boolean {
  return session.metadata?.surface === MANAGED_SESSION_NAMESPACE
    && /^[a-f0-9]{64}$/u.test(session.metadata.scope ?? "")
    && Number.isFinite(session.last_active_at)
    && now - session.last_active_at * 1000 >= MANAGED_SESSION_IDLE_MS;
}

export async function cleanupManagedSessions(client: OpenAI, options: { now?: number; signal: AbortSignal }) {
  const counts = { scanned: 0, deleted: 0, failed: 0 };
  let page = await client.beta.agents.sessions.list({ order: "asc", limit: 100 }, { signal: options.signal });
  while (true) {
    // Fetch the next cursor before deleting anything that pagination may reference.
    const next = page.hasNextPage() ? await page.getNextPage() : undefined;
    const candidates = page.data.filter((session) => isExpiredManagedSession(session, options.now ?? Date.now()));
    counts.scanned += page.data.length;
    for (let offset = 0; offset < candidates.length; offset += 5) {
      const batch = await Promise.allSettled(candidates.slice(offset, offset + 5).map(async (candidate) => {
        try {
          const current = await client.beta.agents.sessions.retrieve(candidate.id, { signal: options.signal });
          if (!isExpiredManagedSession(current, options.now ?? Date.now())) return false;
          if (current.status === "in_progress" || current.status === "requires_action") {
            await client.beta.agents.sessions.events.create(current.id, { events: [{ type: "agent.session.input.cancel" }] }, { signal: options.signal });
          }
          // Cancellation is asynchronous. A transient active-turn conflict must
          // not leave expired business data behind until the next hourly run.
          for (let attempt = 0; ; attempt += 1) {
            try {
              await client.beta.agents.sessions.delete(current.id, { signal: options.signal, maxRetries: 0 });
              break;
            } catch (error) {
              if (!(error instanceof OpenAI.APIError) || error.status !== 409 || attempt === 4) throw error;
              await delay(250 * (attempt + 1), undefined, { signal: options.signal });
            }
          }
          return true;
        } catch (error) {
          if (error instanceof OpenAI.APIError && error.status === 404) return true;
          throw error;
        }
      }));
      for (const result of batch) {
        if (result.status === "rejected") counts.failed += 1;
        else if (result.value) counts.deleted += 1;
      }
      options.signal.throwIfAborted();
    }
    if (!next) return counts;
    page = next;
  }
}
