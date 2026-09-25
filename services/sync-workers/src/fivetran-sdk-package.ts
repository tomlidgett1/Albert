import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { crc32 } from "node:zlib";

/**
 * Package the Xero Connector SDK project for Fivetran's code upload
 * (`POST /v1/deploy/{group}/{schema}` — the same call `fivetran deploy` makes).
 *
 * Fivetran accepts `.py` files plus `requirements.txt` at the project root
 * (subdirectories are allowed but only for those file types). We write a
 * plain STORED zip — no compression, no dependencies — with a fixed timestamp
 * so the archive bytes are a function of the source alone and its SHA-256 can
 * be recorded on the connection for provenance.
 */
export type SdkPackage = Readonly<{ bytes: Buffer; sha256: string; files: readonly string[] }>;

const INCLUDE = /\.py$|(^|\/)requirements\.txt$/u;
const EXCLUDE_DIRS = new Set(["tests", "__pycache__", "files", ".git"]);

export function packageSdkProject(projectDir: string): SdkPackage {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry)) walk(full);
        continue;
      }
      const rel = relative(projectDir, full).split("\\").join("/");
      if (INCLUDE.test(rel)) files.push(rel);
    }
  };
  walk(projectDir);
  if (!files.includes("connector.py")) {
    throw new Error(`fivetran_sdk_project_invalid:${projectDir} has no connector.py`);
  }
  // Fivetran's packager always adds a (possibly empty) serialised
  // configuration form alongside the code; mirror it so the package is
  // shaped exactly like one `fivetran deploy` would upload.
  const entries = [
    ...files.map((name) => ({ name, data: readFileSync(join(projectDir, name)) })),
    { name: "configuration_form.pb", data: Buffer.alloc(0) },
  ];
  const bytes = storedZip(entries);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), files };
}

// DOS date/time for 2026-01-01 00:00:00 — deterministic archives.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function storedZip(entries: readonly Readonly<{ name: string; data: Buffer }>[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}
