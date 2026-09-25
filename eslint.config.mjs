import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    ".albert-build/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".dlt/**",
    ".venv/**",
    ".albert-gt-fly.mts",
    ".albert-probe-*.mts",
    ".albert-qa.mts",
    ".albert-sql-first-smoke.mts",
    "next-env.d.ts",
  ]),
  {
    files: [
      "app/dash/page.tsx",
      "app/dash/components/ArchitectureMap.tsx",
      "app/dash/components/ConnectionsWorkspace.tsx",
      "app/dash/components/InsightsStyleTrace.tsx",
    ],
    // These pre-existing dashboard state machines intentionally coordinate
    // animation frames, DOM measurements, and resumable streams through refs.
    // Keep the React Compiler-only restrictions scoped off until that legacy
    // shell is decomposed; V2 authoring components remain fully checked.
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
