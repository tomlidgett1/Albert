import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";

/**
 * Fivetran re-typed the Deputy roster instants once already: dp_rosters
 * stores shift_date / starts_at / ends_at as varchar (the deprecated
 * timestamptz columns sit beside them). Every time-typed roster dimension
 * must cast, or time filters fail with "operator does not exist: character
 * varying >= timestamp with time zone" (15 production failures on
 * 2026-09-01 before the cast shipped).
 */
const CUBE_FILE = path.resolve("cube-playground/model/cubes/deputy_workforce.yml");

type Dimension = { name: string; type?: string; sql?: string };
type Cube = { name: string; dimensions?: Dimension[]; segments?: Array<{ name: string; sql?: string }> };

test("every time dimension on deputy_rosters casts its varchar instant", () => {
  const document = load(readFileSync(CUBE_FILE, "utf8")) as { cubes?: Cube[] };
  const rosters = document.cubes?.find((cube) => cube.name === "deputy_rosters");
  assert.ok(rosters, "deputy_rosters cube is missing");
  const timeDimensions = (rosters.dimensions ?? []).filter((dimension) => dimension.type === "time");
  assert.ok(timeDimensions.length >= 3, "expected the roster date and start/end instants");
  for (const dimension of timeDimensions) {
    assert.match(
      dimension.sql ?? "",
      /::timestamptz/u,
      `deputy_rosters.${dimension.name} reads a varchar instant without casting: ${dimension.sql}`,
    );
  }
});
