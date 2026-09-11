import { z } from "zod";
import { managedSessionStateSchema, emptyManagedSessionState, type ManagedSessionState } from "../../../packages/albert-agents-api/src/session-state.js";
import { priorResultsFromTraceEvents, type PriorTurnResult } from "../../../packages/albert-v3/src/engine/prior-results.js";
import type { ConversationSupabase } from "./artifact-store.js";
import { ControlPlaneError } from "../../control-plane/src/web-repository.js";

export async function claimManagedAgentState(input: Readonly<{
  supabase: ConversationSupabase; conversationId: string; turnId: string; serverKey: string;
}>) {
  const { data, error } = await input.supabase.rpc("albert_claim_managed_agent_session", {
    p_conversation_id: input.conversationId, p_turn_id: input.turnId, p_server_key: input.serverKey,
  });
  if (error) throw new ControlPlaneError("The managed conversation could not be opened safely.", 503);
  const row = z.object({ state: z.record(z.string(), z.unknown()), revision: z.number().int().nonnegative(), updatedAt: z.string() }).parse(data);
  let revision = row.revision;
  const state = Object.keys(row.state).length ? managedSessionStateSchema.parse(row.state) : emptyManagedSessionState();
  if (state.clientTurnId) {
    const visible = await input.supabase.rpc("albert_managed_turn_visible", {
      p_conversation_id: input.conversationId, p_turn_id: state.clientTurnId, p_server_key: input.serverKey,
    });
    if (visible.error) throw new ControlPlaneError("The managed conversation history could not be checked.", 503);
    if (visible.data !== true) state.idleConfirmed = false;
  }
  return {
    state,
    complete: async () => {
      const { error } = await input.supabase.rpc("albert_complete_managed_agent_turn", {
        p_conversation_id: input.conversationId, p_turn_id: input.turnId, p_server_key: input.serverKey,
      });
      if (error) throw new ControlPlaneError("The completed managed answer could not be finalized.", 503);
    },
    save: async (next: ManagedSessionState) => {
      const { data: saved, error: failure } = await input.supabase.rpc("albert_save_managed_agent_session", {
        p_conversation_id: input.conversationId, p_turn_id: input.turnId,
        p_revision: revision, p_state: managedSessionStateSchema.parse(next), p_server_key: input.serverKey,
      });
      if (failure || !Number.isSafeInteger(saved)) throw new ControlPlaneError("The managed conversation could not be saved safely.", 503);
      revision = saved as number;
    },
    loadResults: async (ids: readonly string[]): Promise<readonly PriorTurnResult[]> => {
      const results: PriorTurnResult[] = [];
      for (let offset = 0; offset < ids.length; offset += 8) {
        const { data: rows, error: failure } = await input.supabase.rpc("albert_managed_agent_results", {
          p_conversation_id: input.conversationId, p_result_ids: ids.slice(offset, offset + 8), p_server_key: input.serverKey,
        });
        if (failure || !Array.isArray(rows)) throw new ControlPlaneError("Earlier evidence could not be restored.", 503);
        for (const row of rows as { table: unknown; query?: unknown }[]) {
          results.push(...priorResultsFromTraceEvents([{ turnsAgo: 1, events: [row.query, row.table].filter(Boolean) }], { maxRows: 500, maxResultsPerTurn: 8 }));
        }
      }
      return results;
    },
  };
}
