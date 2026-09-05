export type ThemePreference = "system" | "light" | "beige" | "sage" | "dark" | "green";

const storageKey = "albert-theme";
const themeChangeEvent = "albert-theme-change";
let snapshot: ThemePreference = "system";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system"
    || value === "light"
    || value === "beige"
    || value === "sage"
    || value === "dark"
    || value === "green";
}

export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") return snapshot;

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (isThemePreference(stored)) snapshot = stored;
  } catch {
    // Keep the in-memory value when storage is unavailable.
  }

  return snapshot;
}

export function getServerThemePreference(): ThemePreference {
  return "system";
}

export function getThemeAppearance(): "light" | "dark" {
  const preference = getThemePreference();
  return preference === "dark" || preference === "green"
    || (preference === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark" : "light";
}

/** Notify memoized charts in the same document, not only other browser tabs. */
export function notifyThemePreferenceChanged(preference: ThemePreference): void {
  snapshot = preference;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(themeChangeEvent));
}

export function subscribeToThemePreference(listener: () => void): () => void {
  const handleStorage = () => listener();
  window.addEventListener("storage", handleStorage);
  window.addEventListener(themeChangeEvent, handleStorage);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", handleStorage);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(themeChangeEvent, handleStorage);
    media.removeEventListener("change", handleStorage);
  };
}
