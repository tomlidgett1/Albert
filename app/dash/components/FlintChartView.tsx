"use client";

import { useEffect, useRef, useState } from "react";
import {
  assembleFlintChart,
  type AssemblableFlintPlan,
  type FlintAppearance,
  type FlintThemeTokens,
} from "../lib/flint-assemble";
import styles from "./test-chart-workspace.module.css";

function resolveColor(host: HTMLElement, property: string): string | undefined {
  const raw = getComputedStyle(host).getPropertyValue(property).trim();
  if (!raw) return undefined;
  if (!/light-dark\(|color-mix\(/u.test(raw)) return raw;
  const probe = document.createElement("span");
  probe.style.color = raw;
  host.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved && resolved !== "rgba(0, 0, 0, 0)" ? resolved : raw;
}

function paintedSurface(host: HTMLElement): string | undefined {
  let node: HTMLElement | null = host;
  while (node) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
    node = node.parentElement;
  }
  return resolveColor(host, "--dash-surface");
}

function readHostTokens(host: HTMLElement): Partial<FlintThemeTokens> {
  const palette = [1, 2, 3, 4]
    .map((index) => resolveColor(host, `--dash-chart-${index}`))
    .filter((color): color is string => Boolean(color));
  return {
    canvas: paintedSurface(host),
    ink: resolveColor(host, "--dash-text-heading"),
    muted: resolveColor(host, "--dash-text-muted"),
    grid: resolveColor(host, "--dash-chart-grid"),
    palette: palette.length >= 2 ? palette : undefined,
  };
}

function hostWidthOf(element: HTMLElement): number {
  return Math.max(240, Math.round(element.getBoundingClientRect().width / 4) * 4);
}

/**
 * Vega draws a complete picture (plot, axes, labels, points). Treat that SVG
 * as an image: a viewBox around every painted mark, then scale to the card
 * width. Never crop it to a fixed frame.
 */
export function containDrawnChart(root: HTMLElement): void {
  const svg = root.querySelector("svg");
  if (!(svg instanceof SVGSVGElement)) return;
  const pad = 8;
  let minX = 0;
  let minY = 0;
  let width = Number(svg.getAttribute("width")) || svg.width.baseVal.value || 1;
  let height = Number(svg.getAttribute("height")) || svg.height.baseVal.value || 1;
  try {
    const box = svg.getBBox();
    if (box.width > 0 && box.height > 0) {
      minX = box.x - pad;
      minY = box.y - pad;
      width = box.width + pad * 2;
      height = box.height + pad * 2;
    }
  } catch {
    minX -= pad;
    minY -= pad;
    width += pad * 2;
    height += pad * 2;
  }
  svg.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.width = "100%";
  svg.style.height = "auto";
  svg.style.display = "block";
  svg.style.overflow = "visible";
  svg.style.maxWidth = "100%";
}

export default function FlintChartView({
  plan,
  appearance,
  title,
  height = 320,
}: Readonly<{
  plan: AssemblableFlintPlan;
  appearance: FlintAppearance;
  title: string;
  height?: number;
}>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("Drawing the chart…");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const next = hostWidthOf(host);
      setHostWidth((current) => (current === next ? current : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || hostWidth < 240) return;
    let cancelled = false;
    let finalize: (() => void) | undefined;
    if (!canvas.querySelector("svg")) {
      setStatus("loading");
      setMessage("Drawing the chart…");
    }

    void (async () => {
      try {
        const embed = (await import("vega-embed")).default;
        if (cancelled) return;
        const assembled = assembleFlintChart(plan, appearance, {
          width: hostWidth,
          height,
          tokens: readHostTokens(canvas),
        });
        const drawn = await embed(canvas, assembled.spec, {
          actions: false,
          ast: true,
          renderer: "svg",
          tooltip: true,
        });
        if (cancelled) {
          drawn.finalize();
          return;
        }
        containDrawnChart(canvas);
        finalize = drawn.finalize;
        setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "The chart could not be drawn.");
      }
    })();

    return () => {
      cancelled = true;
      finalize?.();
    };
  }, [appearance, height, hostWidth, plan]);

  return (
    <div className={styles.chartHost} ref={hostRef}>
      {status !== "ready" ? (
        <p className={styles.pending} role="status">{message}</p>
      ) : null}
      <div
        ref={canvasRef}
        className={styles.chartCanvas}
        aria-label={title}
        data-ready={status === "ready" ? "true" : "false"}
      />
    </div>
  );
}
