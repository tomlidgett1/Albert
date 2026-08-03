import { createHash } from "node:crypto";

export type SemanticBundleInput = Readonly<{
  registryVersion: string;
  overlayVersion: string;
  identityGraph: Readonly<{ version: number; hash: string }>;
  packVersions: Readonly<Record<string, string>>;
  sourceWatermarks: Readonly<Record<string, string>>;
  ir: unknown;
}>;

export function semanticBundleHash(input: SemanticBundleInput): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function contentDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  const rendered = JSON.stringify(value);
  return rendered === undefined ? "null" : rendered;
}
