/**
 * Native connector capabilities: "delegate to the connector's own tool when it
 * beats the semantic layer" as a first-class, registry-driven pattern.
 *
 * Some answers are better fetched from the source system than rebuilt from
 * governed views. Xero's P&L is now landed by Fivetran and governed in
 * CubeCore; Balance Sheet and Trial Balance remain native until their report
 * tables are qualified. A future connector may ship an
 * MCP report, a forecast, or a computed metric that no view reproduces. Each
 * such capability registers here with (a) a deterministic detector for the
 * question shapes it owns, (b) a description the intent orchestrator uses for
 * intent-based routing when the wording is indirect, (c) an availability check
 * (client configured + connector connected), and (d) the lane that runs it.
 * The engine consults the registry; it never hard-codes a connector.
 *
 * Adding a native capability for connector #47 = one registry entry.
 */
import type { FinalAnswer, LaneRunInput } from "./lanes.js";
import type { V3TurnContext } from "./context.js";
import { detectXeroStatementRequest, runStatementLane, type XeroStatementKind } from "./statement-lane.js";

export type NativeCapability = Readonly<{
  /** Stable id, e.g. "xero.statement". */
  id: string;
  /** Control-plane connector keys that make it available. */
  connectorKeys: readonly string[];
  /** Human name for progress labels. */
  label: string;
  /** Kinds (sub-capabilities) with routing descriptions for the intent orchestrator. */
  kinds: ReadonlyArray<Readonly<{ kind: string; description: string }>>;
  /** Deterministic detection from the owner's message; undefined when not owned. */
  detect: (message: string) => string | undefined;
  /** Whether the runtime has what it needs (a signed client, a role) this turn. */
  isAvailable: (context: Pick<V3TurnContext, "xeroMcp">) => boolean;
  /** Runs the capability; Escalate/undefined hands back to the general path. */
  run: (input: LaneRunInput, kind: string) => Promise<FinalAnswer | undefined>;
}>;

const xeroStatements: NativeCapability = Object.freeze({
  id: "xero.statement",
  connectorKeys: ["xero", "fivetran-xero"],
  label: "Live Xero statement",
  kinds: [
    { kind: "balance_sheet", description: "Xero's own Balance Sheet: assets, liabilities, equity / net assets, bank account balances as at a date." },
    { kind: "trial_balance", description: "Xero's own Trial Balance: every ledger account's balance as at a date." },
  ],
  detect: (message) => detectXeroStatementRequest(message),
  isAvailable: (context) => Boolean(context.xeroMcp),
  run: (input, kind) => runStatementLane(input, kind as XeroStatementKind),
});

export const NATIVE_CAPABILITIES: readonly NativeCapability[] = Object.freeze([xeroStatements]);

export type NativeCapabilityMatch = Readonly<{ capability: NativeCapability; kind: string }>;

function connected(capability: NativeCapability, activeConnectors: readonly string[] | undefined): boolean {
  // Unknown connection state fails open, like the rest of routing.
  if (!activeConnectors || activeConnectors.length === 0) return true;
  return capability.connectorKeys.some((key) => activeConnectors.includes(key));
}

/** Deterministic pre-classification detection. */
export function detectNativeCapability(
  message: string,
  context: Pick<V3TurnContext, "xeroMcp">,
  activeConnectors: readonly string[] | undefined,
): NativeCapabilityMatch | undefined {
  for (const capability of NATIVE_CAPABILITIES) {
    if (!capability.isAvailable(context) || !connected(capability, activeConnectors)) continue;
    const kind = capability.detect(message);
    if (kind && capability.kinds.some((k) => k.kind === kind)) return { capability, kind };
  }
  return undefined;
}

/** Resolves an orchestrator-chosen "id:kind" reference. */
export function resolveNativeCapability(
  reference: string | null | undefined,
  context: Pick<V3TurnContext, "xeroMcp">,
  activeConnectors: readonly string[] | undefined,
): NativeCapabilityMatch | undefined {
  if (!reference) return undefined;
  const [id, kind] = reference.split(":");
  const capability = NATIVE_CAPABILITIES.find((c) => c.id === id);
  if (!capability || !kind || !capability.kinds.some((k) => k.kind === kind)) return undefined;
  if (!capability.isAvailable(context) || !connected(capability, activeConnectors)) return undefined;
  return { capability, kind };
}

/** The block the intent orchestrator sees for the tenant's connected tools. */
export function renderNativeCapabilitiesForClassifier(activeConnectors: readonly string[] | undefined): string {
  const lines: string[] = [];
  for (const capability of NATIVE_CAPABILITIES) {
    if (!connected(capability, activeConnectors)) continue;
    for (const kind of capability.kinds) lines.push(`- ${capability.id}:${kind.kind} — ${kind.description}`);
  }
  if (lines.length === 0) return "";
  return `
Native connector capabilities (the source system's own report beats rebuilding it from views).
When the question is answered by one of these — even when it does not name the report — set
nativeCapability to its "id:kind" and lane to quick; the engine fetches it live. Leave null when the
question needs a grain the report lacks (per product/customer/supplier, joins with another tool).
${lines.join("\n")}
`;
}
