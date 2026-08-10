import { readFile } from "node:fs/promises";
import { z } from "zod";

const columnSchema = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  type: z.string().min(1),
  description: z.string().min(1),
  key: z.boolean(),
  pii: z.boolean(),
  loadBearing: z.boolean(),
  deprecated: z.boolean(),
  enums: z.union([z.array(z.string()), z.string()]).nullable(),
}).passthrough();

const tableSchema = z.object({
  id: z.string().regex(/^ls_[a-z0-9_]+$/),
  domain: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  grain: z.string().min(1),
  description: z.string().min(1),
  additivity: z.string().min(1),
  additivityAxis: z.string().nullable(),
  primaryKey: z.array(z.string()).min(1),
  gotchas: z.array(z.string()),
  columns: z.array(columnSchema).min(1),
}).passthrough();

const catalogueSchema = z.object({
  generatedFrom: z.string().min(1),
  tableCount: z.number().int().positive(),
  tables: z.array(tableSchema),
}).strict().superRefine((value, context) => {
  if (value.tableCount !== value.tables.length) {
    context.addIssue({ code: "custom", path: ["tableCount"], message: "Declared table count does not match the catalogue." });
  }
  if (new Set(value.tables.map((table) => table.id)).size !== value.tables.length) {
    context.addIssue({ code: "custom", path: ["tables"], message: "Lightspeed table identifiers must be unique." });
  }
});

export type LightspeedTable = z.infer<typeof tableSchema>;
export type LightspeedCatalogue = z.infer<typeof catalogueSchema>;

export async function loadLightspeedCatalogue(path: string): Promise<LightspeedCatalogue> {
  const parsed = catalogueSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (parsed.tableCount !== 90) throw new Error(`Anthropic analytics requires the complete 90-table Lightspeed catalogue; found ${parsed.tableCount}.`);
  return parsed;
}

function tokens(value: string): readonly string[] {
  return value.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function tableSearchText(table: LightspeedTable): string {
  return [
    table.id,
    table.domain,
    table.grain,
    table.description,
    ...table.primaryKey,
    ...table.gotchas,
    ...table.columns.flatMap((column) => [column.name, column.description]),
  ].join(" ").toLowerCase();
}

export function searchLightspeedCatalogue(
  catalogue: LightspeedCatalogue,
  query: string,
  limit = 8,
): readonly LightspeedTable[] {
  const needles = [...new Set(tokens(query))];
  return Object.freeze(catalogue.tables
    .map((table) => {
      const text = tableSearchText(table);
      const score = needles.reduce((total, token) => {
        if (table.id.includes(token)) return total + 10;
        if (table.domain.includes(token)) return total + 6;
        if (table.primaryKey.some((key) => key.includes(token))) return total + 5;
        if (table.columns.some((column) => column.name.includes(token))) return total + 4;
        return text.includes(token) ? total + 1 : total;
      }, 0);
      return { table, score };
    })
    .filter(({ score }) => score > 0 || needles.length === 0)
    .sort((left, right) => right.score - left.score || left.table.id.localeCompare(right.table.id))
    .slice(0, Math.max(1, Math.min(20, limit)))
    .map(({ table }) => table));
}

export function describeLightspeedTable(table: LightspeedTable): Readonly<Record<string, unknown>> {
  return Object.freeze({
    relation: `source_lightspeed.${table.id}`,
    domain: table.domain,
    grain: table.grain,
    description: table.description,
    additivity: table.additivity,
    additivityAxis: table.additivityAxis,
    primaryKey: table.primaryKey,
    mandatoryScope: ["tenant_id = $trusted_tenant", "mapping_version = active mapping version", "tombstone = false"],
    gotchas: table.gotchas,
    columns: table.columns.map((column) => ({
      name: column.name,
      type: column.type,
      description: column.description,
      key: column.key,
      pii: column.pii,
      loadBearing: column.loadBearing,
      deprecated: column.deprecated,
      enums: column.enums,
    })),
  });
}
