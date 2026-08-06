/**
 * Extends the Lightspeed contract fixture to cover every spec stream.
 *
 * The existing fixture states its own provenance: "Sanitized contract recording
 * shaped from the pinned official R-Series V3 documentation; live dogfood
 * recording pending credentials." The 77 streams added by the spec are shaped
 * the same way, from the same documentation, via tables.json — so the fixture
 * keeps one consistent provenance rather than mixing recorded and invented data.
 *
 * Existing recorded streams are never overwritten: only missing ones are added.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { LIGHTSPEED_STREAMS } from "../connectors/lightspeed-r/streams.js";
import { SPEC_TABLES } from "../connectors/lightspeed-r/scan-plan.js";

const FIXTURE = new URL("../connectors/lightspeed-r/fixtures/sanitized-recording.json", import.meta.url);

type Fixture = {
  fixtureVersion: number;
  provenance: string;
  responses: Record<string, unknown>;
};

/** A documented value for one column, typed as the vendor would return it. */
function sampleValue(column: { name: string; type: string; api: string }, seed: number): unknown {
  const leaf = column.api.split(".").pop() ?? column.name;
  switch (column.type) {
    case "integer":
    case "bigint":
      // Ids must be positive: R-Series uses 0 as an absent-reference sentinel,
      // and a 0 here would be read as "no parent" by the mappers.
      return /id$/i.test(leaf) ? seed : seed;
    case "numeric":
    case "real":
      return "0.00";
    case "boolean":
      return "false";
    case "timestamp":
      return "2026-01-01T00:00:00+00:00";
    case "date":
      return "2026-01-01";
    case "jsonb":
      return {};
    default:
      return `${leaf}-${seed}`;
  }
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
const before = Object.keys(fixture.responses).length;
let added = 0;

for (const stream of LIGHTSPEED_STREAMS) {
  if (fixture.responses[stream.id] !== undefined) continue; // never clobber a recording
  const table = SPEC_TABLES.find((candidate) => candidate.id === stream.id);
  if (!table) continue;

  const record: Record<string, unknown> = {};
  let seed = 1;
  for (const column of table.columns) {
    const leaf = column.api.split(".").pop() ?? column.name;
    if (leaf in record) continue;
    record[leaf] = sampleValue(column, seed);
    seed += 1;
  }
  // The record id must be present and stable: the harness reads it directly.
  if (stream.recordIdField && record[stream.recordIdField] === undefined) {
    record[stream.recordIdField] = 1;
  }

  fixture.responses[stream.id] = { [stream.resource]: [record] };
  added += 1;
}

writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`fixture streams: ${before} -> ${Object.keys(fixture.responses).length} (+${added})`);
