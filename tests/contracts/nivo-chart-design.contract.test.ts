import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BAR_LAYERS,
  DEFAULT_NIVO_CHART_DESIGN,
  LINE_CURVES,
  LINE_LAYERS,
  NIVO_COLOR_SCHEMES,
  barDesignToNivoProps,
  lineDesignToNivoProps,
  normalizeNivoChartDesign,
} from "../../packages/shared/src/nivo-chart-design.js";

async function read(relativePath: string) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("shipped Nivo defaults cover bar, line and theme surfaces from the 0.99 API", () => {
  const design = DEFAULT_NIVO_CHART_DESIGN;
  assert.equal(design.version, 1);
  assert.ok(design.colors.palette.length >= 4);
  assert.ok(NIVO_COLOR_SCHEMES.includes(design.colors.scheme));
  assert.ok(LINE_CURVES.includes(design.line.curve));
  assert.deepEqual([...design.bar.layers], [...BAR_LAYERS]);
  assert.deepEqual([...design.line.layers], [...LINE_LAYERS]);

  const bar = barDesignToNivoProps(design);
  const line = lineDesignToNivoProps(design);
  for (const key of [
    "padding", "innerPadding", "borderRadius", "borderWidth", "groupMode", "layout",
    "enableLabel", "labelPosition", "enableTotals", "axisTop", "axisRight", "axisBottom",
    "axisLeft", "legends", "theme", "motionConfig", "layers",
  ]) {
    assert.ok(key in bar, `bar props must include ${key}`);
  }
  for (const key of [
    "curve", "lineWidth", "enableArea", "areaBlendMode", "enablePoints", "pointSize",
    "useMesh", "enableSlices", "enableCrosshair", "crosshairType", "axisTop", "axisRight",
    "axisBottom", "axisLeft", "legends", "theme", "motionConfig", "layers",
  ]) {
    assert.ok(key in line, `line props must include ${key}`);
  }
});

test("normalize fills missing Nivo design fields from shipped defaults", () => {
  const next = normalizeNivoChartDesign({
    bar: { padding: 0.5, borderRadius: 12 },
    line: { curve: "step", lineWidth: 6 },
    colors: { mode: "scheme", scheme: "set2" },
  });
  assert.equal(next.bar.padding, 0.5);
  assert.equal(next.bar.borderRadius, 12);
  assert.equal(next.bar.innerPadding, DEFAULT_NIVO_CHART_DESIGN.bar.innerPadding);
  assert.equal(next.line.curve, "step");
  assert.equal(next.line.lineWidth, 6);
  assert.equal(next.colors.mode, "scheme");
  assert.equal(next.colors.scheme, "set2");
  assert.equal(next.theme.background, DEFAULT_NIVO_CHART_DESIGN.theme.background);
});

test("Admin Charts publishes the design into live ResultChart rendering", async () => {
  const [admin, studio, chart, route, publicRoute] = await Promise.all([
    read("app/dash/components/AdminWorkspace.tsx"),
    read("app/dash/components/ChartDesignStudio.tsx"),
    read("app/dash/components/AnalyticalTrace.tsx"),
    read("app/api/admin/chart-design/route.ts"),
    read("app/api/chart-design/route.ts"),
  ]);

  assert.match(admin, /label: "Charts"/);
  assert.match(admin, /ChartDesignStudio/);
  assert.match(studio, /Save as Albert default/);
  assert.match(studio, /ResponsiveBar/);
  assert.match(studio, /ResponsiveLine/);
  assert.match(studio, /https:\/\/nivo\.rocks\/bar\//);
  assert.match(studio, /https:\/\/nivo\.rocks\/line\//);
  assert.match(chart, /usePublishedNivoChartDesign/);
  assert.match(chart, /barDesignToNivoProps/);
  assert.match(chart, /lineDesignToNivoProps/);
  assert.match(route, /isInternalOperator/);
  assert.match(route, /export async function PUT/);
  assert.match(publicRoute, /loadPublishedChartDesign/);
});

test("chart design CSS stays dash-native across themes and reduced motion", async () => {
  const styles = await read("app/dash/components/chart-design.module.css");
  assert.match(styles, /var\(--dash-control-height\)/);
  assert.match(styles, /var\(--dash-surface\)/);
  assert.match(styles, /var\(--dash-text-heading\)/);
  assert.match(styles, /border-radius: 16px/);
  assert.match(styles, /border-radius: 999px/);
  assert.match(styles, /@media \(max-width: 680px\)/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/iu);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /transition: none !important/);
});
