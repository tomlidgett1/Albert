import type { TraceCell } from "../../../packages/shared/src/index.js";

const numericTokenPattern = /(?<![\p{L}\d])[-+]?\$?\d[\d,]*(?:\.\d+)?%?(?![\p{L}\d])/gu;

function normalizeNumericToken(value: string): string {
  const stripped = value.replace(/[$,%+]/g, "");
  const numeric = Number(stripped);
  return Number.isFinite(numeric) ? String(numeric) : stripped;
}

/**
 * Prevents model-authored figures from entering a governed narrative. Every
 * numeric token must occur in a result cell or be a server-derived row count.
 */
export function findUngroundedNumbers(
  narrative: string,
  rows: readonly Readonly<Record<string, TraceCell>>[],
): readonly string[] {
  const grounded = new Set<string>();
  grounded.add(String(rows.length));
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (typeof value === "number") grounded.add(normalizeNumericToken(String(value)));
      if (typeof value === "string" && /^[-+]?\d[\d,]*(?:\.\d+)?%?$/u.test(value.trim())) {
        grounded.add(normalizeNumericToken(value));
      }
    }
  }
  const tokens = narrative.match(numericTokenPattern) ?? [];
  return Object.freeze(tokens.filter((token) => !grounded.has(normalizeNumericToken(token))));
}
