import { z } from "zod";

export const resultReferencesSchema = z.record(z.string().regex(/^r[1-9][0-9]{0,5}$/u), z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u)).refine((value) => Object.keys(value).length <= 512);
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const REFERENCE = /^r[1-9][0-9]{0,5}$/u;
const referenceKeys = new Set(["resultId", "secondResultId", "dataRef"]);
const referenceLists = new Set(["resultIds", "citedResultIds", "presentedResultIds"]);

/** Compact model handles, scoped to one authenticated conversation. */
export class ResultReferences {
  private readonly byAlias = new Map<string, string>();
  private readonly byId = new Map<string, string>();
  constructor(saved: Readonly<Record<string, string>> = {}) {
    for (const [alias, id] of Object.entries(resultReferencesSchema.parse(saved))) {
      this.byAlias.set(alias, id); this.byId.set(id, alias);
    }
  }
  resolve(alias: string): string | undefined { return this.byAlias.get(alias); }
  snapshot(): Record<string, string> { return Object.fromEntries(this.byAlias); }
  register(id: string): string {
    const existing = this.byId.get(id);
    if (existing) return existing;
    if (!ULID.test(id) || this.byAlias.size >= 512) throw new Error("The result reference limit was reached. Start a new analysis.");
    const next = Math.max(0, ...Array.from(this.byAlias.keys(), (key) => Number(key.slice(1)))) + 1;
    const alias = `r${next}`; this.byAlias.set(alias, id); this.byId.set(id, alias); return alias;
  }
  decode(value: unknown, key = ""): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string" && (referenceKeys.has(key) || referenceLists.has(key))) {
      const id = this.resolve(value);
      if (!id) throw new Error(`Unknown result ${value}. Available results: ${[...this.byAlias.keys()].join(", ") || "none yet"}.`);
      return id;
    }
    if (Array.isArray(value)) return value.map((entry) => this.decode(entry, key));
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, this.decode(entry, name)]));
    return value;
  }
  encode(value: unknown, key = ""): unknown {
    if (key === "rows") return value;
    if (typeof value === "string" && (referenceKeys.has(key) || referenceLists.has(key)) && ULID.test(value)) return this.register(value);
    if (Array.isArray(value)) return value.map((entry) => this.encode(entry, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, this.encode(entry, name)]));
    return value;
  }
  referencedIds(value: unknown): string[] {
    const found = new Set<string>();
    const visit = (entry: unknown, key = "") => {
      if (typeof entry === "string" && (referenceKeys.has(key) || referenceLists.has(key) || key === "result" || key === "citedResults") && REFERENCE.test(entry)) {
        const id = this.resolve(entry); if (id) found.add(id);
      } else if (Array.isArray(entry)) entry.forEach((child) => visit(child, key));
      else if (entry && typeof entry === "object") Object.entries(entry).forEach(([name, child]) => visit(child, name));
    };
    visit(value); return [...found];
  }
}
