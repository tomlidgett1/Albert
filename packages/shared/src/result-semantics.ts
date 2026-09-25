import { z } from "zod";

export const resultSemanticsSchema = z.object({
  version: z.literal(1),
  completeness: z.enum(["complete", "limited", "unknown"]),
  returnedRows: z.number().int().min(0),
  rowLimit: z.number().int().positive().nullable(),
  grain: z.array(z.string().max(200)).max(20),
  keys: z.record(z.string().max(160), z.object({ kind: z.enum(["identifier", "period"]), domain: z.string().max(300) }).strict()),
  window: z.string().max(4_000),
  queryDigest: z.string().max(200),
  semanticVersionDigest: z.string().max(200),
  qualifications: z.array(z.string().max(500)).max(20).optional(),
  inputWindows: z.array(z.string().max(4_000)).max(30).optional(),
  inputGrains: z.array(z.array(z.string().max(200)).max(20)).max(30).optional(),
}).strict();

/** Host-authored semantics that survive previews, derivations and replay. */
export type ResultSemantics = Readonly<{
  version: 1;
  completeness: "complete" | "limited" | "unknown";
  returnedRows: number;
  rowLimit: number | null;
  /** The selected dimensions, including a bucket's granularity. */
  grain: readonly string[];
  /** Keys with a proven meaning; display names are deliberately absent. */
  keys: Readonly<Record<string, Readonly<{
    kind: "identifier" | "period";
    /** Independent source IDs are not interchangeable across domains. */
    domain: string;
  }>>>;
  /** Canonical window + timezone; independent time fields can share a window. */
  window: string;
  queryDigest: string;
  semanticVersionDigest: string;
  qualifications?: readonly string[];
  inputWindows?: readonly string[];
  inputGrains?: readonly (readonly string[])[];
}>;
