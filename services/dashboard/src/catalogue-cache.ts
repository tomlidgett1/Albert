/**
 * The governed catalogue is global to the model and changes only on a Cube
 * deploy; every dashboard path that needs it (refresh batches, requery,
 * the element editor's field list) shares one in-process copy per Cube
 * origin for five minutes instead of paying a /v1/meta round trip each.
 */
import type { CubeClient } from "@/packages/albert-v3/src/cube/client";
import type { CubeCatalogue } from "@/packages/albert-v3/src/cube/types";

export const CATALOGUE_TTL_MS = 5 * 60_000;
const catalogueCache = new Map<string, { fetchedAt: number; promise: Promise<CubeCatalogue> }>();

export async function cachedCatalogue(apiUrl: string, client: CubeClient): Promise<CubeCatalogue> {
  const now = Date.now();
  const cached = catalogueCache.get(apiUrl);
  if (cached && now - cached.fetchedAt < CATALOGUE_TTL_MS) return cached.promise;
  const promise = client.fetchCatalogue(AbortSignal.timeout(20_000));
  catalogueCache.set(apiUrl, { fetchedAt: now, promise });
  try {
    return await promise;
  } catch (error) {
    catalogueCache.delete(apiUrl);
    throw error;
  }
}
