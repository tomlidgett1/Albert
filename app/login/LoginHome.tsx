"use client";

import { useEffect, useRef } from "react";
import styles from "./login.module.css";

function scrollToSignIn() {
  const gate = document.getElementById("albert-sign-in");
  if (!gate) return;

  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) {
    gate.scrollIntoView();
    return;
  }

  const start = window.scrollY;
  const end = gate.getBoundingClientRect().top + window.scrollY;
  const distance = end - start;
  const duration = Math.min(1400, Math.max(700, Math.abs(distance) * 0.7));
  const startedAt = performance.now();

  const ease = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  const frame = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    window.scrollTo(0, start + distance * ease(progress));
    if (progress < 1) requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

export function scrollToLoginHome() {
  const home = document.getElementById("albert-home");
  if (!home) return;

  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) {
    home.scrollIntoView();
    return;
  }

  const start = window.scrollY;
  const end = home.getBoundingClientRect().top + window.scrollY;
  const distance = end - start;
  const duration = Math.min(1600, Math.max(900, Math.abs(distance) * 0.85));
  const startedAt = performance.now();

  const ease = (t: number) => 1 - Math.pow(1 - t, 3.2);

  const frame = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    window.scrollTo(0, start + distance * ease(progress));
    if (progress < 1) requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

export default function LoginHome() {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const items = root.querySelectorAll<HTMLElement>(`[data-reveal]`);
    if (!items.length) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      items.forEach((item) => item.setAttribute("data-revealed", "true"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-revealed", "true");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );

    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={rootRef}
      id="albert-home"
      className={styles.home}
      aria-label="About Albert"
    >
      <div className={styles.homeInner}>
        <header className={styles.homeHero} data-reveal>
          <h2 className={styles.homeHeroTitle}>
            Analytics that stay governed, connected, and private.
          </h2>
          <button
            type="button"
            className={styles.homeCloseButton}
            onClick={scrollToSignIn}
          >
            Back to sign in
          </button>
        </header>
      </div>
    </section>
  );
}
