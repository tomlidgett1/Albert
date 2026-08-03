import type { NextConfig } from "next";

const publicSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const declaredBuildSha = (
  process.env.GITHUB_SHA?.trim() || process.env.ALBERT_BUILD_SHA?.trim() || ""
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
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  ...(process.env.NODE_ENV === "production"
    ? ["upgrade-insecure-requests"]
    : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
] as const;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Vinext converts next.config env entries into compile-time definitions.
  // Runtime environment changes therefore cannot relabel an older web bundle.
  env: {
    ALBERT_BUILD_SHA: embeddedBuildSha,
  },
  generateBuildId: async () => embeddedBuildSha || "albert-unversioned-build",
  async headers() {
    return [{ source: "/(.*)", headers: [...securityHeaders] }];
  },
};

export default nextConfig;
