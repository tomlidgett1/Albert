import type { NextConfig } from "next";

const publicSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const declaredBuildSha = (
  process.env.VERCEL === "1"
    ? process.env.VERCEL_GIT_COMMIT_SHA?.trim() || ""
    : process.env.GITHUB_SHA?.trim() ||
      process.env.ALBERT_BUILD_SHA?.trim() ||
      ""
).toLowerCase();
const embeddedBuildSha = /^[a-f0-9]{40}$/u.test(declaredBuildSha)
  ? declaredBuildSha
  : "";

function supabaseConnectSources(value: string): string[] {
  if (!value) return [];

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return [];

    const websocketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    return [url.origin, `${websocketProtocol}//${url.host}`];
  } catch {
    return [];
  }
}

const connectSources = [
  "'self'",
  "https://*.supabase.co",
  "wss://*.supabase.co",
  ...supabaseConnectSources(publicSupabaseUrl),
];

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  `connect-src ${[...new Set(connectSources)].join(" ")}`,
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  // Next's development React refresh runtime requires eval. Production
  // continues to forbid it; see the bundled Next CSP development guide.
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  ...(process.env.NODE_ENV === "production"
    ? ["upgrade-insecure-requests"]
    : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=()" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
] as const;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Instant Navigations: Cache Components + Partial Prefetching (Next.js 16.3).
  // Static shells and Suspense fallbacks render immediately; dynamic regions stream.
  cacheComponents: true,
  partialPrefetching: true,
  // Vinext skips the Next typecheck gate; keep Vercel builds unblocked while
  // local `npm run typecheck` remains the authority for TypeScript health.
  typescript: {
    ignoreBuildErrors: true,
  },
  // Vinext converts next.config env entries into compile-time definitions.
  // Runtime environment changes therefore cannot relabel an older web bundle.
  env: {
    ALBERT_BUILD_SHA: embeddedBuildSha,
  },
  generateBuildId: async () => embeddedBuildSha || "albert-unversioned-build",
  // Plain Next/Vercel builds need TypeScript ESM extension rewriting and
  // Vite-style `?raw` imports that vinext already provides for Sites.
  webpack: (config) => {
    // Constrained local QA can skip the regenerable filesystem cache without
    // changing the application bundle or weakening the production CSP.
    if (process.env.ALBERT_BUILD_NO_CACHE === "true") config.cache = false;
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    config.module = config.module ?? {};
    config.module.rules = config.module.rules ?? [];
    config.module.rules.push({
      resourceQuery: /raw/,
      type: "asset/source",
    });
    return config;
  },
  async headers() {
    return [{ source: "/(.*)", headers: [...securityHeaders] }];
  },
};

export default nextConfig;
