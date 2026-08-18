"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_NIVO_CHART_DESIGN,
  normalizeNivoChartDesign,
  type NivoChartDesign,
} from "@/packages/shared/src";

export const nivoChartDesignEventName = "albert:nivo-chart-design-change";
const storageKey = "albert:nivo-chart-design:v1";

let snapshot = DEFAULT_NIVO_CHART_DESIGN;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(nivoChartDesignEventName));
  }
}

function readStoredDesign(): NivoChartDesign | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? normalizeNivoChartDesign(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeStoredDesign(design: NivoChartDesign) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(design));
  } catch {
    // Live charts still update from memory when browser storage is blocked.
  }
}

export function publishNivoChartDesign(design: NivoChartDesign) {
  snapshot = normalizeNivoChartDesign(design);
  writeStoredDesign(snapshot);
  emit();
}

export function getPublishedNivoChartDesign(): NivoChartDesign {
  return snapshot;
}

async function hydrateFromNetwork() {
  try {
    const response = await fetch("/api/chart-design", { cache: "no-store" });
    const payload = await response.json() as { design?: unknown };
    if (!response.ok || !payload.design) return;
    publishNivoChartDesign(normalizeNivoChartDesign(payload.design));
  } catch {
    // Shipped defaults and any cached design remain in place.
  }
}

function ensureHydrated() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const stored = readStoredDesign();
  if (stored) snapshot = stored;
  void hydrateFromNetwork();
}

export function usePublishedNivoChartDesign(): NivoChartDesign {
  const subscribe = useCallback((notify: () => void) => {
    listeners.add(notify);
    const acceptChange = () => notify();
    const acceptStorage = (event: StorageEvent) => {
      if (event.key === storageKey) {
        const stored = readStoredDesign();
        if (stored) snapshot = stored;
        notify();
      }
    };
    window.addEventListener(nivoChartDesignEventName, acceptChange);
    window.addEventListener("storage", acceptStorage);
    return () => {
      listeners.delete(notify);
      window.removeEventListener(nivoChartDesignEventName, acceptChange);
      window.removeEventListener("storage", acceptStorage);
    };
  }, []);

  useEffect(() => {
    ensureHydrated();
  }, []);

  return useSyncExternalStore(subscribe, () => snapshot, () => DEFAULT_NIVO_CHART_DESIGN);
}

export async function reloadPublishedNivoChartDesign(): Promise<NivoChartDesign> {
  await hydrateFromNetwork();
  return snapshot;
}
