import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = await readFile(new URL("../../playwright.config.ts", import.meta.url), "utf8");

test("browser acceptance declares the same analytical runtime selector required in production", () => {
  assert.match(config, /ALBERT_ANALYTICAL_RUNTIME:\s*"v1"/u);
});
