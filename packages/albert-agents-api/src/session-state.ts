import { createHash } from "node:crypto";
import { z } from "zod";
import { resultReferencesSchema } from "./references.js";

export const MANAGED_SESSION_NAMESPACE = "albert-managed-analyst-v2";
export const MANAGED_SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
export const managedSessionStateSchema = z.object({
  version: z.literal(2),
  sessionId: z.string().regex(/^sess_[a-zA-Z0-9_-]+$/u).optional(),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  contextDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  catalogueDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  lastProviderTurnId: z.string().max(200).optional(),
  clientTurnId: z.string().max(100).optional(),
  idleConfirmed: z.boolean().default(false),
  references: resultReferencesSchema,
  inspectedTopics: z.array(z.string().max(200)).max(100),
}).strict();
export type ManagedSessionState = z.infer<typeof managedSessionStateSchema>;
export type ManagedSessionScope = Readonly<{ tenantId: string; actorId: string; conversationId: string; turnId: string }>;

export function managedSessionScopeDigest(scope: ManagedSessionScope): string {
  return createHash("sha256").update(JSON.stringify([scope.tenantId, scope.actorId, scope.conversationId])).digest("hex");
}

export function emptyManagedSessionState(): ManagedSessionState {
  return { version: 2, references: {}, inspectedTopics: [], idleConfirmed: false };
}
