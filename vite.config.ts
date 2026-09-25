import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };
import { sites } from "./build/sites-vite-plugin.js";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  // Sites still injects nodejs_compat, so pin the last date where that flag is explicit.
  compatibility_date: "2026-07-31",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    // Match Next's public-variable contract for the browser environment.
    // Server-only values remain workerd bindings and are never exposed here.
    envPrefix: ["VITE_", "NEXT_PUBLIC_"],
    server: {
      // Local Lightspeed OAuth requires an HTTPS callback. Cloudflare quick
      // tunnels terminate on *.trycloudflare.com and proxy to this Vite server.
      allowedHosts: [".trycloudflare.com", "localhost", "127.0.0.1"],
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      {
        name: "albert-stub-vega-on-worker",
        applyToEnvironment(environment: { name: string }) {
          return environment.name === "rsc" || environment.name === "ssr";
        },
        resolveId(id: string) {
          if (
            id === "vega"
            || id === "vega-lite"
            || id === "vega-embed"
            || id === "vega-interpreter"
          ) {
            return `\0albert-vega-stub:${id}`;
          }
          return undefined;
        },
        load(id: string) {
          if (id.startsWith("\0albert-vega-stub:")) {
            return "export default {};\nexport const expressionInterpreter = {};\n";
          }
          return undefined;
        },
      },
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
