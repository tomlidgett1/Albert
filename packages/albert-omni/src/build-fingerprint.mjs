import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Includes dirty source changes and dependencies; never reads configuration or secrets. */
export function computeOmniBuildFingerprint(root = process.cwd()) {
  const hash = createHash("sha256");
  const roots = ["packages/albert-omni/src", "packages/albert-codex/src", "packages/albert-v3/src", "packages/agent/src", "packages/shared/src", "packages/security/src", "packages/config/src", "services/codex-runtime/src", "services/conversation/src", "services/control-plane/src", "cube-playground"];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:ts|mjs|js|yaml|yml|json)$/.test(entry.name)) files.push(path);
    }
  };
  for (const directory of roots) visit(join(root, directory));
  files.push(join(root, "package.json"), join(root, "package-lock.json"));
  for (const path of files.sort()) {
    hash.update(relative(root, path)); hash.update("\0");
    hash.update(readFileSync(path)); hash.update("\0");
  }
  return hash.digest("hex");
}

let developmentHash;
export function omniBuildFingerprint() {
  // Replaced by the service builder; production identity has no mutable env seam.
  if (typeof __ALBERT_OMNI_BUILD_HASH__ === "string") return __ALBERT_OMNI_BUILD_HASH__;
  developmentHash ??= computeOmniBuildFingerprint();
  return developmentHash;
}
