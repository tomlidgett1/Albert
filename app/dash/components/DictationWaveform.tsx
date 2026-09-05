"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import styles from "../dash.module.css";

type DictationWaveformProps = {
  /** Live mic loudness from 0..1. Quiet keeps the idle pulse; speech boosts bar height. */
  volume?: number;
  /** Keep a soft processing pulse while the transcript request is in flight. */
  processing?: boolean;
  label?: string;
};

/**
 * Full-width voice bars (LocalMode / ElevenLabs-style):
 * staggered sine idle motion on every bar, then amplitude boost from live volume.
 */
export default function DictationWaveform({
  volume = 0,
  processing = false,
  label = "Listening",
}: DictationWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const readAnimationState = useEffectEvent(() => ({ volume, processing }));

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let rafId = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const nextWidth = Math.max(1, Math.floor(wrap.clientWidth));
      const nextHeight = Math.max(1, Math.floor(wrap.clientHeight));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = nextWidth;
      height = nextHeight;
      canvas.width = Math.floor(nextWidth * dpr);
      canvas.height = Math.floor(nextHeight * dpr);
      canvas.style.width = `${nextWidth}px`;
      canvas.style.height = `${nextHeight}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(wrap);
    resize();

    const barColor = getComputedStyle(wrap).color || "currentColor";
    const startedAt = performance.now();

    const draw = (now: number) => {
      const elapsed = (now - startedAt) / 1000;
      const animationState = readAnimationState();
      const loudness = Math.min(1, Math.max(0, animationState.volume));
      const isProcessing = animationState.processing;

      context.clearRect(0, 0, width, height);

      const barWidth = 2.5;
      const gap = 3;
      const stride = barWidth + gap;
      const barCount = Math.max(8, Math.floor((width + gap) / stride));
      const totalWidth = barCount * barWidth + (barCount - 1) * gap;
      const originX = (width - totalWidth) / 2;
      const midY = height / 2;
      const minHeight = 3;
      const idleAmp = isProcessing ? 3.2 : 2.4;
      const speechAmp = (height - 8) * 0.92;

      context.fillStyle = barColor;

      for (let index = 0; index < barCount; index += 1) {
        // Staggered sinusoid so every bar is always moving a little (idle / processing).
        const phase = index * 0.55;
        const idleWave = reduceMotion
          ? 0.55
          : 0.55 + 0.45 * Math.sin(elapsed * (isProcessing ? 3.4 : 2.6) + phase);
        // Mild centre emphasis so speech looks organic, not a flat wall.
        const envelope = 0.55 + 0.45 * Math.sin((index / Math.max(1, barCount - 1)) * Math.PI);
        const speech = loudness * speechAmp * envelope;
        const barHeight = Math.max(
          minHeight,
          minHeight + idleAmp * idleWave + speech,
        );
        const x = originX + index * stride;
        const y = midY - barHeight / 2;
        const radius = Math.min(barWidth / 2, barHeight / 2);

        context.globalAlpha = 0.34 + loudness * 0.45 + idleWave * 0.12;
        context.beginPath();
        if (typeof context.roundRect === "function") {
          context.roundRect(x, y, barWidth, barHeight, radius);
        } else {
          context.rect(x, y, barWidth, barHeight);
        }
        context.fill();
      }

      context.globalAlpha = 1;
      rafId = window.requestAnimationFrame(draw);
    };

    rafId = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className={styles.dictationWave}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <canvas ref={canvasRef} className={styles.dictationCanvas} />
    </div>
  );
}
