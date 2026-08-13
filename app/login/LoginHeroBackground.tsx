"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import {
  getServerThemePreference,
  getThemePreference,
  subscribeToThemePreference,
} from "@/app/theme-preference";
import styles from "./login.module.css";

const PixelBlast = dynamic(() => import("./PixelBlast"), {
  ssr: false,
});

const PIXEL_COLORS: Record<string, string> = {
  light: "#5F7F3A",
  system: "#5F7F3A",
  beige: "#5F7F3A",
  sage: "#5F7F3A",
  green: "#C8E3B0",
  dark: "#C5DB9A",
} as const;

export default function LoginHeroBackground() {
  const theme = useSyncExternalStore(
    subscribeToThemePreference,
    getThemePreference,
    getServerThemePreference,
  );
  const pixelColor = PIXEL_COLORS[theme] ?? PIXEL_COLORS.light;

  return (
    <div className={styles.heroAtmosphere} aria-hidden="true">
      <div className={styles.heroWash} />
      <div className={styles.pixelBlastLayer}>
        <PixelBlast
          variant="circle"
          pixelSize={5}
          color={pixelColor}
          patternScale={3.2}
          patternDensity={1.15}
          pixelSizeJitter={0.35}
          enableRipples
          rippleSpeed={0.4}
          rippleThickness={0.12}
          rippleIntensityScale={1.25}
          liquid
          liquidStrength={0.1}
          liquidRadius={1.2}
          liquidWobbleSpeed={5}
          speed={0.55}
          edgeFade={0.28}
          transparent
        />
      </div>
    </div>
  );
}
