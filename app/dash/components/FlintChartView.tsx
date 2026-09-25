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
  return Math.max(200, Math.round(element.getBoundingClientRect().width / 4) * 4);
}

/**
 * Vega draws a complete picture (plot, axes, labels, points). Treat that SVG
 * as an image: a viewBox around every painted mark, then scale to the card
 * width. Never crop it to a fixed frame.
 *
 * Returns the framed viewBox height so fill-mode callers can compare what was
 * actually drawn against the space they have.
 */
export function containDrawnChart(root: HTMLElement, fitBox = false): number {
  const svg = root.querySelector("svg");
  if (!(svg instanceof SVGSVGElement)) return 0;
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
  // Fill mode letterboxes inside the card instead of dictating the card's
  // height, so an over-tall drawing scales down rather than clipping.
  svg.style.height = fitBox ? "100%" : "auto";
  if (fitBox) svg.style.maxHeight = "100%";
  svg.style.display = "block";
  svg.style.overflow = "visible";
  svg.style.maxWidth = "100%";
  if (fitBox) {
    // Percentage heights only resolve through sized ancestors; the embed
    // wrappers between the card box and the SVG default to auto.
    let node = svg.parentElement;
    while (node && node !== root) {
      node.style.height = "100%";
      node.style.minHeight = "0";
      node.style.display = "block";
      node = node.parentElement;
    }
  }
  return height;
}

/**
 * The vertical chrome (title gap, x axis, legend) Vega draws beyond the plot
 * height. Fill mode measures the real value after the first draw and redraws
 * once, so the finished SVG matches the card box instead of guessing.
 */
const INITIAL_FILL_OVERHEAD = 76;
const MIN_FILL_PLOT_HEIGHT = 96;

export default function FlintChartView({
  plan,
  appearance,
  title,
  height = 320,
  fill = false,
}: Readonly<{
  plan: AssemblableFlintPlan;
  appearance: FlintAppearance;
  title: string;
  height?: number;
  /**
   * Size the drawing to the host box (both axes) instead of a fixed plot
   * height: measures the axis/legend overhead from the first draw, redraws
   * at the corrected plot height, and letterboxes any residual difference.
   * The host must live inside a box with a real height.
   */
  fill?: boolean;
}>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const [hostHeight, setHostHeight] = useState(0);
  const [fillOverhead, setFillOverhead] = useState(INITIAL_FILL_OVERHEAD);
  const correctedSizeRef = useRef("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("Drawing the chart…");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const nextWidth = hostWidthOf(host);
      setHostWidth((current) => (current === nextWidth ? current : nextWidth));
      if (fill) {
        const nextHeight = Math.max(0, Math.round(host.getBoundingClientRect().height));
        setHostHeight((current) => (Math.abs(current - nextHeight) <= 2 ? current : nextHeight));
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [fill]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || hostWidth < 200) return;
    if (fill && hostHeight < MIN_FILL_PLOT_HEIGHT) return;
    let cancelled = false;
    let finalize: (() => void) | undefined;
    if (!canvas.querySelector("svg")) {
      setStatus("loading");
      setMessage("Drawing the chart…");
    }

    const plotHeight = fill
      ? Math.max(MIN_FILL_PLOT_HEIGHT, hostHeight - fillOverhead)
      : height;

    void (async () => {
      try {
        const embed = (await import("vega-embed")).default;
        if (cancelled) return;
        const assembled = assembleFlintChart(plan, appearance, {
          width: hostWidth,
          height: plotHeight,
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
        const drawnHeight = containDrawnChart(canvas, fill);
        finalize = drawn.finalize;
        if (fill && drawnHeight > 0) {
          // One corrective redraw per box size: the measured chrome replaces
          // the estimate, so the plot fills what the chrome leaves free.
          const sizeKey = `${hostWidth}x${hostHeight}`;
          const measuredOverhead = Math.round(drawnHeight - plotHeight);
          const nextOverhead = Math.min(
            Math.max(24, measuredOverhead + 2),
            Math.max(24, Math.round(hostHeight * 0.6)),
          );
          if (
            Math.abs(drawnHeight - hostHeight) > 14
            && Math.abs(nextOverhead - fillOverhead) > 6
            && correctedSizeRef.current !== sizeKey
          ) {
            correctedSizeRef.current = sizeKey;
            setFillOverhead(nextOverhead);
          }
        }
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
  }, [appearance, fill, fillOverhead, height, hostHeight, hostWidth, plan]);

  return (
    <div
      className={styles.chartHost}
      ref={hostRef}
      style={fill ? { height: "100%", minHeight: 0 } : undefined}
    >
      {status !== "ready" ? (
        <p className={styles.pending} role="status">{message}</p>
      ) : null}
      <div
        ref={canvasRef}
        className={styles.chartCanvas}
        aria-label={title}
        data-ready={status === "ready" ? "true" : "false"}
        style={fill ? { height: "100%", minHeight: 0 } : undefined}
      />
    </div>
  );
}
