import type { SemanticResultCache, SemanticToolResponse } from "./types.js";

export class MemorySemanticResultCache implements SemanticResultCache {
  private readonly entries = new Map<string, { expiresAt: number; value: SemanticToolResponse }>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<SemanticToolResponse | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: SemanticToolResponse, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }
}
