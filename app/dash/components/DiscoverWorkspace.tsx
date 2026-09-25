"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import {
  DISCOVER_DOMAIN_LABELS,
  DISCOVER_DOMAINS,
  type DiscoverCard,
  type DiscoverConnector,
  type DiscoverDomain,
} from "@/services/discover/src/library";
import { CONNECTOR_LOGOS, CONNECTOR_NAMES } from "./connectors";
import styles from "./discover.module.css";

type Source = "cache" | "library" | "model" | "empty";

type DiscoverPayload = Readonly<{
  cards?: readonly DiscoverCard[];
  connectors?: readonly DiscoverConnector[];
  business?: string;
  source?: Source;
  error?: string;
}>;

type Status = "loading" | "ready" | "error";

const EASE = [0.22, 1, 0.36, 1] as const;
const SKELETON_COUNT = 9;

const DOMAIN_SET = new Set<string>(DISCOVER_DOMAINS);
const CONNECTOR_SET = new Set<string>(Object.keys(CONNECTOR_LOGOS));

function isCard(value: unknown): value is DiscoverCard {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && typeof item.title === "string"
    && typeof item.why === "string"
    && typeof item.prompt === "string"
    && typeof item.domain === "string" && DOMAIN_SET.has(item.domain)
    && Array.isArray(item.tools) && item.tools.every((tool) => typeof tool === "string" && CONNECTOR_SET.has(tool));
}

function listInEnglish(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function ToolLogos({ tools, className, ring }: { tools: readonly DiscoverConnector[]; className: string; ring: string }) {
  return (
    <span className={className} title={listInEnglish(tools.map((tool) => CONNECTOR_NAMES[tool]))}>
      {tools.map((tool) => (
        <span className={ring} key={tool}>
          <Image src={CONNECTOR_LOGOS[tool]} alt="" width={14} height={14} unoptimized />
        </span>
      ))}
    </span>
  );
}

function SkeletonCard() {
  return (
    <div className={styles.skeleton} aria-hidden="true">
      <span className={styles.skeletonBar} data-width="label" />
      <span className={styles.skeletonBar} data-width="title" />
      <span className={styles.skeletonBar} data-width="line" />
      <span className={styles.skeletonBar} data-width="short" />
    </div>
  );
}

export default function DiscoverWorkspace({
  organisationName,
  onAsk,
  onOpenConnections,
  reduceMotion,
  panelId,
  labelledBy,
}: Readonly<{
  organisationName: string;
  onAsk: (prompt: string) => void;
  onOpenConnections: () => void;
  reduceMotion: boolean;
  panelId: string;
  labelledBy: string;
}>) {
  const [cards, setCards] = useState<readonly DiscoverCard[]>([]);
  const [connectors, setConnectors] = useState<readonly DiscoverConnector[]>([]);
  const [business, setBusiness] = useState(organisationName);
  const [source, setSource] = useState<Source>("library");
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [tailoring, setTailoring] = useState(false);
  const [filter, setFilter] = useState<DiscoverDomain | "all">("all");
  const [generation, setGeneration] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const applyPayload = useCallback((payload: DiscoverPayload | null) => {
    if (!payload) return false;
    const next = (payload.cards ?? []).filter(isCard);
    setCards(next);
    setConnectors((payload.connectors ?? []).filter((tool): tool is DiscoverConnector => CONNECTOR_SET.has(tool)));
    if (typeof payload.business === "string" && payload.business.trim()) setBusiness(payload.business.trim());
    if (payload.source) setSource(payload.source);
    setGeneration((current) => current + 1);
    return true;
  }, []);

  const tailor = useCallback(async (refresh: boolean, signal: AbortSignal) => {
    setTailoring(true);
    try {
      const response = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(refresh ? { refresh: true } : {}),
        signal,
      });
      if (signal.aborted) return;
      const payload = await response.json().catch(() => null) as DiscoverPayload | null;
      if (response.ok) applyPayload(payload);
    } catch {
      // The library stays on screen; personalisation is best-effort.
    } finally {
      if (!signal.aborted) setTailoring(false);
    }
  }, [applyPayload]);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    setError("");
    try {
      const response = await fetch("/api/discover", { cache: "no-store", signal: controller.signal });
      const payload = await response.json().catch(() => null) as DiscoverPayload | null;
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setStatus("error");
        setError(payload?.error || "Discover could not be loaded.");
        return;
      }
      applyPayload(payload);
      setStatus("ready");
      if (payload?.source === "library" && (payload.cards?.length ?? 0) > 0) {
        await tailor(false, controller.signal);
      }
    } catch (loadError) {
      if (controller.signal.aborted) return;
      setStatus("error");
      setError(loadError instanceof Error ? loadError.message : "Discover could not be loaded.");
    }
  }, [applyPayload, tailor]);

  useEffect(() => {
    // Deferred so the first paint is the skeleton, not a synchronous state cascade.
    queueMicrotask(() => void load());
    return () => abortRef.current?.abort();
  }, [load]);

  const refresh = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void tailor(true, controller.signal);
  };

  const domains = useMemo(
    () => DISCOVER_DOMAINS.filter((domain) => cards.some((card) => card.domain === domain)),
    [cards],
  );
  // A filter whose domain vanished after a refresh falls back to "all" without a state round-trip.
  const activeFilter: DiscoverDomain | "all" = filter !== "all" && domains.includes(filter) ? filter : "all";
  const visible = useMemo(
    () => (activeFilter === "all" ? cards : cards.filter((card) => card.domain === activeFilter)),
    [cards, activeFilter],
  );

  const subtitle = status === "loading"
    ? "Reading your connected tools…"
    : tailoring
      ? `Tailoring these to ${business}…`
      : "Pick one and Albert investigates.";

  const empty = status === "ready" && cards.length === 0;

  return (
    <section
      className={styles.discover}
      id={panelId}
      role="tabpanel"
      aria-labelledby={labelledBy}
      data-testid="discover-workspace"
      data-source={source}
    >
      {empty ? (
        <div className={styles.empty}>
          <span className={styles.emptyGlyph} aria-hidden="true">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="m14.8 9.2-1.7 4.3-4.3 1.7 1.7-4.3 4.3-1.7Z" /></svg>
          </span>
          <h2 className={styles.emptyTitle}>Connect a tool to unlock Discover</h2>
          <p className={styles.emptyBody}>
            Discover fills with questions worth asking once Albert can see your sales, accounting or rostering data.
          </p>
          <button className={styles.emptyAction} type="button" onClick={onOpenConnections}>
            Open connections
          </button>
        </div>
      ) : (
        <div className={styles.inner}>
          <header className={styles.header}>
            <div className={styles.headerCopy}>
              <h2 className={styles.title}>What’s possible with your data</h2>
              <p className={styles.lede} role="status">
                {tailoring ? <span className={styles.statusDot} aria-hidden="true" /> : null}
                {subtitle}
              </p>
            </div>
            {connectors.length > 0 ? (
              <ToolLogos tools={connectors} className={styles.headerToolStack} ring={styles.headerToolMark} />
            ) : null}
          </header>

          {status === "error" ? (
            <div className={styles.error} role="alert">
              <p>{error}</p>
              <button className={styles.retry} type="button" onClick={() => void load()}>Try again</button>
            </div>
          ) : null}

          {status === "ready" && cards.length > 0 ? (
            <div className={styles.toolbar}>
              <div className={styles.filters} role="group" aria-label="Filter by area">
                <button
                  className={styles.filter}
                  type="button"
                  aria-pressed={activeFilter === "all"}
                  onClick={() => setFilter("all")}
                >
                  All
                </button>
                {domains.map((domain) => (
                  <button
                    className={styles.filter}
                    key={domain}
                    type="button"
                    aria-pressed={activeFilter === domain}
                    onClick={() => setFilter(domain)}
                  >
                    {DISCOVER_DOMAIN_LABELS[domain]}
                  </button>
                ))}
              </div>
              <button
                className={styles.refresh}
                type="button"
                disabled={tailoring}
                aria-label="Refresh ideas"
                title="Ask Albert for a fresh set of questions"
                onClick={refresh}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19.5 9" /><path d="M19.5 4.5V9H15" /><path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4.5 15" /><path d="M4.5 19.5V15H9" />
                </svg>
                <span>New ideas</span>
              </button>
            </div>
          ) : null}

          <div className={styles.grid} aria-busy={status === "loading" || tailoring}>
            {status === "loading"
              ? Array.from({ length: SKELETON_COUNT }, (_, index) => <SkeletonCard key={index} />)
              : visible.map((card, index) => (
                  <motion.button
                    className={styles.card}
                    key={`${generation}:${card.id}`}
                    type="button"
                    data-domain={card.domain}
                    data-testid="discover-card"
                    aria-label={`Ask: ${card.prompt}`}
                    title={card.prompt}
                    layout={!reduceMotion}
                    initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.42,
                      ease: EASE,
                      delay: reduceMotion ? 0 : Math.min(index * 0.028, 0.5),
                      layout: { duration: reduceMotion ? 0 : 0.32, ease: EASE },
                    }}
                    onClick={() => onAsk(card.prompt)}
                  >
                    <span className={styles.domain}>{DISCOVER_DOMAIN_LABELS[card.domain]}</span>
                    <span className={styles.cardTitle}>{card.title}</span>
                    <span className={styles.cardWhy}>{card.why}</span>
                    <span className={styles.cardFoot}>
                      <span className={styles.toolsWrap}>
                        <ToolLogos tools={card.tools} className={styles.tools} ring={styles.toolMark} />
                        <span className={styles.toolNames}>{listInEnglish(card.tools.map((tool) => CONNECTOR_NAMES[tool]))}</span>
                      </span>
                      <span className={styles.arrow} aria-hidden="true">
                        <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                      </span>
                    </span>
                  </motion.button>
                ))}
          </div>
        </div>
      )}
    </section>
  );
}
