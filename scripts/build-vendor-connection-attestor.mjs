import { rm } from "node:fs/promises";
import { build } from "esbuild";

const outdir = ".albert-build/vendor-connection-attestor";
await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: { main: "services/vendor-connection-attestor/src/main.ts" },
  outdir,
  bundle: true,
  platform: "node",
  target: "node22.13",
  format: "esm",
  sourcemap: true,
  sourcesContent: false,
  legalComments: "none",
  logLevel: "info",
});
