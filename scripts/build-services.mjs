import { rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const outdir = ".albert-build/services";
const requestedBuildSha = process.env.GITHUB_SHA ?? process.env.ALBERT_BUILD_SHA;
const buildSha = requestedBuildSha?.trim() || "development";
if (buildSha !== "development" && !/^[a-f0-9]{40}$/u.test(buildSha)) {
  throw new Error("Service builds require a full lowercase Git SHA or the local development sentinel.");
}
if (process.env.GITHUB_ACTIONS === "true" && buildSha === "development") {
  throw new Error("GitHub Actions service builds require GITHUB_SHA.");
}

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: {
    "sync-worker": "services/sync-workers/src/main.ts",
    "deletion-worker": "services/deletion-worker/src/main.ts",
    "webhook-gateway": "services/webhook-gateway/src/main.ts",
    "operator-diagnostic": "services/operator-diagnostic/src/main.ts",
    "codex-runtime": "services/codex-runtime/src/main.ts",
  },
  outdir,
  bundle: true,
  platform: "node",
  target: "node22.13",
  format: "esm",
  packages: "external",
  define: {
    __ALBERT_SERVICE_BUILD_SHA__: JSON.stringify(buildSha),
  },
  sourcemap: true,
  sourcesContent: false,
  legalComments: "none",
  logLevel: "info",
});
await writeFile(
  `${outdir}/build-identity.json`,
  `${JSON.stringify({ buildSha }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o444 },
);
