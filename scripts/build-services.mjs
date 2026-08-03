import { rm } from "node:fs/promises";
import { build } from "esbuild";

const outdir = ".albert-build/services";

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: {
    "semantic-query": "services/semantic-query/src/main.ts",
    "sync-worker": "services/sync-workers/src/main.ts",
    "transform-worker": "services/transform-worker/src/main.ts",
    "deletion-worker": "services/deletion-worker/src/main.ts",
    "webhook-gateway": "services/webhook-gateway/src/main.ts",
  },
  outdir,
  bundle: true,
  platform: "node",
  target: "node22.13",
  format: "esm",
  packages: "external",
  sourcemap: true,
  sourcesContent: false,
  legalComments: "none",
  logLevel: "info",
});
