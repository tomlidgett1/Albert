const fallbackRedirect = "/dash";
const unsafePathCharacters = /[\\\u0000-\u001f\u007f]/u;
const encodedUnsafePathCharacters = /%(?:00|01|02|03|04|05|06|07|08|09|0a|0b|0c|0d|0e|0f|10|11|12|13|14|15|16|17|18|19|1a|1b|1c|1d|1e|1f|5c|7f)/iu;

/**
 * Resolve the post-auth destination against the browser origin and retain only
 * Albert's reviewed dashboard deep links. Returning a relative path
 * also prevents a later router implementation from reinterpreting credentials,
 * a network-path reference, or a browser-normalized backslash as another origin.
 */
export function safeDashboardRedirect(value: string | null | undefined, origin: string): string {
  if (
    !value
    || !value.startsWith("/")
    || value.startsWith("//")
    || unsafePathCharacters.test(value)
    || encodedUnsafePathCharacters.test(value)
  ) {
    return fallbackRedirect;
  }

  try {
    const trustedOrigin = new URL(origin);
    const candidate = new URL(value, trustedOrigin);
    if (
      !["https:", "http:"].includes(trustedOrigin.protocol)
      || candidate.origin !== trustedOrigin.origin
      || candidate.username
      || candidate.password
      || candidate.hash
    ) {
      return fallbackRedirect;
    }

    if (candidate.pathname === "/dash/acceptance") {
      if ([...candidate.searchParams.keys()].some((key) => key !== "journey")) {
        return fallbackRedirect;
      }
      const journeys = candidate.searchParams.getAll("journey");
      return journeys.length === 1 && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(journeys[0] ?? "")
        ? `/dash/acceptance?journey=${journeys[0]}`
        : fallbackRedirect;
    }

    if (candidate.pathname !== "/dash") return fallbackRedirect;

    if ([...candidate.searchParams.keys()].some((key) => key !== "view")) {
      return fallbackRedirect;
    }
    const views = candidate.searchParams.getAll("view");
    if (views.length > 1 || (views.length === 1 && views[0] !== "Connections")) {
      return fallbackRedirect;
    }
    return views.length === 1 ? "/dash?view=Connections" : fallbackRedirect;
  } catch {
    return fallbackRedirect;
  }
}
