import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import yaml from "js-yaml";

const modelRoot = path.resolve(import.meta.dirname, "../../cube-playground/model");

// Cube processes YAML through Jinja and then compiles SQL as Python f-strings.
// PostgreSQL's brace-form text-array literal conflicts with those two template
// syntaxes, including when the braces are doubled. Use ARRAY['parent', 'child']
// for #>/#>> operands and keep semantic substitutions such as {CUBE} single-braced.
const braceFormPostgresJsonPath = /#[ \t]*>>?[ \t]*'\{{1,2}[^'\r\n]+\}{1,2}'/u;
const literalEmptyObject = /['"]\{\}['"]/u;

function yamlFiles(directory: string): readonly string[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return yamlFiles(absolute);
      return entry.isFile() && /\.ya?ml$/u.test(entry.name) ? [absolute] : [];
    })
    .sort();
}

function sqlValues(value: unknown, location = "$", found: string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => sqlValues(entry, `${location}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, entry] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (key === "sql" && typeof entry === "string") found.push(`${childLocation}\0${entry}`);
    else sqlValues(entry, childLocation, found);
  }
  return found;
}

test("Cube YAML uses template-safe PostgreSQL JSON paths without escaping semantic substitutions", () => {
  assert.match("payload_json #>> '{parent,child}'", braceFormPostgresJsonPath);
  assert.match("payload_json #>> '{{parent,child}}'", braceFormPostgresJsonPath);
  assert.doesNotMatch("payload_json #>> ARRAY['parent', 'child']", braceFormPostgresJsonPath);
  assert.doesNotMatch("{CUBE}.tenant_id = {orders}.tenant_id", braceFormPostgresJsonPath);

  const violations: string[] = [];
  for (const file of yamlFiles(modelRoot)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(new RegExp(braceFormPostgresJsonPath.source, "gu"))) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${path.relative(modelRoot, file)}:${line}: ${match[0]}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    "PostgreSQL #>/#>> operands must use ARRAY[...] because brace literals collide with Cube's Jinja/Python compilers",
  );
});

test("Cube YAML does not embed an empty-object brace literal in templated SQL", () => {
  assert.match("COALESCE(value, '{}')", literalEmptyObject);
  assert.doesNotMatch("COALESCE(value, jsonb_build_object()::text)", literalEmptyObject);

  const violations: string[] = [];
  for (const file of yamlFiles(modelRoot)) {
    const document = yaml.load(fs.readFileSync(file, "utf8"));
    for (const locatedSql of sqlValues(document)) {
      const separator = locatedSql.indexOf("\0");
      const location = locatedSql.slice(0, separator);
      const sql = locatedSql.slice(separator + 1);
      if (literalEmptyObject.test(sql)) {
        violations.push(`${path.relative(modelRoot, file)}:${location}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    "Literal '{}' collides with Cube's template compiler; construct an empty JSON object without braces",
  );
});
