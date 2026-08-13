export type ThemePreference = "system" | "light" | "beige" | "sage" | "dark" | "green";

const storageKey = "albert-theme";
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

export function subscribeToThemePreference(listener: () => void): () => void {
  const handleStorage = () => listener();
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}
