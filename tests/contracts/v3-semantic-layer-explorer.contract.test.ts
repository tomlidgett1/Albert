import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function read(relativePath: string) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("semantic explorer bundles every tracked Cube model file", async () => {
  const route = await read("app/api/admin/semantic-layer/route.ts");
  const modelRoot = path.join(fileURLToPath(root), "cube-playground", "model");

  for (const directory of ["cubes", "views"] as const) {
    const files = (await readdir(path.join(modelRoot, directory)))
      .filter((file) => file.endsWith(".yml"));
    assert.ok(files.length > 0, `${directory} must contain semantic model files`);
    for (const file of files) {
      assert.match(
        route,
        new RegExp(`cube-playground/model/${directory}/${file.replaceAll(".", "\\.")}\\?raw`),
        `${directory}/${file} must be bundled into the operator catalogue`,
      );
    }
  }

  assert.match(route, /ALBERT_V3_AGENT_CONFIG/);
  assert.match(route, /cube-playground\/model \+ cube-playground\/agents/);
  assert.match(route, /definitionYaml/);
  assert.match(route, /files: MODEL_SOURCES\.map/);
});

test("semantic explorer is operator-gated, read-only and no-store", async () => {
  const route = await read("app/api/admin/semantic-layer/route.ts");

  assert.match(route, /isInternalOperator/);
  assert.match(route, /Internal operator access is required/);
  assert.match(route, /Cache-Control": "private, no-store"/);
  assert.doesNotMatch(route, /ANALYTICAL_DATABASE_URL|CONTROL_PLANE_DATABASE_URL|diagnostic_ro|semantic_ro/);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/);
});

test("Admin exposes exhaustive app, object, member and raw-definition navigation", async () => {
  const [admin, explorer] = await Promise.all([
    read("app/dash/components/AdminWorkspace.tsx"),
    read("app/dash/components/SemanticLayerExplorer.tsx"),
  ]);

  assert.match(admin, /label: "Semantic layer"/);
  assert.match(admin, /label: "Charts"/);
  assert.match(admin, /SemanticLayerExplorer/);
  assert.match(admin, /ChartDesignStudio/);
  for (const label of [
    "All apps",
    "Cubes",
    "Views",
    "Cube fields",
    "View exposures",
    "View source paths",
    "Relationships",
    "Agent routing guidance",
    "Full parsed definition (YAML)",
    "Exact source file",
    "Certified queries",
  ]) {
    assert.match(explorer, new RegExp(label.replace(/[()]/gu, "\\$&")));
  }
  assert.match(explorer, /aria-label="Semantic layer apps"/);
  assert.match(explorer, /aria-label="Search fields"/);
  assert.match(explorer, /sourceMember/);
});

test("semantic explorer remains dash-native across themes, mobile and reduced motion", async () => {
  const styles = await read("app/dash/components/semantic-admin.module.css");
  const explorerStyles = styles.slice(styles.indexOf("/* V3 Cube semantic-layer explorer."));

  assert.match(explorerStyles, /var\(--dash-control-height\)/);
  assert.match(explorerStyles, /var\(--dash-surface\)/);
  assert.match(explorerStyles, /var\(--dash-text-heading\)/);
  assert.match(explorerStyles, /border-radius: 16px/);
  assert.match(explorerStyles, /border-radius: 999px/);
  assert.match(explorerStyles, /@media \(max-width: 680px\)/);
  assert.doesNotMatch(explorerStyles, /#[0-9a-f]{3,8}\b/iu);

  const fullStyles = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(fullStyles, /\.workspace \*/);
  assert.match(fullStyles, /transition: none !important/);
});
