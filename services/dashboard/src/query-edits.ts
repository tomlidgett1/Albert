/**
 * Deterministic query-shape edits on one dashboard element (ADR 0134,
 * migration 0187): Sigma's "Truncate date", the element's date range and
 * comparison, adding or removing a column or calculation, and the row
 * limit. The browser never sends a query — it sends one of these edits, the
 * server patches the governed recipe's CubeQuery, validates the result
 * against the live catalogue for the same view, runs it once, and stores
 * the re-minted digest-locked recipe with its snapshot.
 */
import { z } from "zod";

import { CUBE_GRANULARITIES } from "@/packages/albert-v3/src/cube/types";
import type {
  CubeCatalogue,
  CubeCatalogueMember,
  CubeQuery,
  CubeTimeDimension,
} from "@/packages/albert-v3/src/cube/types";

const memberSchema = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u).max(160);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const explicitRangeSchema = z.tuple([isoDateSchema, isoDateSchema]);

/** The relative windows Cube understands, spelled the way the editor offers them. */
export const DASHBOARD_RELATIVE_DATE_RANGE = /^(?:today|yesterday|this (?:week|month|quarter|year)|last (?:week|month|quarter|year)|last [1-9]\d{0,2} (?:day|week|month|quarter|year)s?)$/u;

export const DASHBOARD_EDIT_GRANULARITIES = ["day", "week", "month", "quarter", "year"] as const;
export type DashboardEditGranularity = (typeof DASHBOARD_EDIT_GRANULARITIES)[number];

export const dashboardQueryEditSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_granularity"),
    dimension: memberSchema,
    granularity: z.enum(DASHBOARD_EDIT_GRANULARITIES),
  }).strict(),
  z.object({
    op: z.literal("set_date_range"),
    dimension: memberSchema,
    dateRange: z.union([z.string().regex(DASHBOARD_RELATIVE_DATE_RANGE), explicitRangeSchema, z.null()]),
  }).strict(),
  z.object({
    op: z.literal("set_compare"),
    dimension: memberSchema,
    compareDateRange: z.union([z.array(explicitRangeSchema).min(2).max(4), z.null()]),
  }).strict(),
  z.object({ op: z.literal("add_measure"), member: memberSchema }).strict(),
  z.object({ op: z.literal("remove_measure"), member: memberSchema }).strict(),
  z.object({
    op: z.literal("add_dimension"),
    member: memberSchema,
    granularity: z.enum(DASHBOARD_EDIT_GRANULARITIES).optional(),
  }).strict(),
  z.object({ op: z.literal("remove_dimension"), member: memberSchema }).strict(),
  z.object({ op: z.literal("set_limit"), limit: z.number().int().min(1).max(500) }).strict(),
]);

export const dashboardQueryEditsSchema = z.array(dashboardQueryEditSchema).min(1).max(8);

export type DashboardQueryEdit = z.infer<typeof dashboardQueryEditSchema>;

export type ApplyEditsResult =
  | Readonly<{ ok: true; query: CubeQuery }>
  | Readonly<{ ok: false; error: string }>;

const MAX_MEASURES = 12;
const MAX_DIMENSIONS = 12;

function memberTitle(member: CubeCatalogueMember | undefined, name: string): string {
  return member?.shortTitle || member?.title || name;
}

function withoutOrder(query: CubeQuery, member: string): CubeQuery {
  if (!query.order || !(member in query.order)) return query;
  const order = Object.fromEntries(Object.entries(query.order).filter(([key]) => key !== member));
  const rest: Record<string, unknown> = { ...query };
  delete rest.order;
  return (Object.keys(order).length > 0 ? { ...rest, order } : rest) as CubeQuery;
}

function replaceTimeDimension(
  query: CubeQuery,
  dimension: string,
  update: (current: CubeTimeDimension) => CubeTimeDimension | null,
): CubeQuery {
  const timeDimensions = (query.timeDimensions ?? []).flatMap((entry) => {
    if (entry.dimension !== dimension) return [entry];
    const next = update(entry);
    return next ? [next] : [];
  });
  const rest: Record<string, unknown> = { ...query };
  delete rest.timeDimensions;
  return (timeDimensions.length > 0 ? { ...rest, timeDimensions } : rest) as CubeQuery;
}

/**
 * Applies the edits in order to the governed base query, staying on the
 * recipe's view. Every failure names what the owner tried to do, never a
 * Cube member, so the element can show it as one line.
 */
export function applyDashboardQueryEdits(
  base: CubeQuery,
  edits: readonly DashboardQueryEdit[],
  catalogue: CubeCatalogue,
  view: string,
): ApplyEditsResult {
  const selectedView = catalogue.views.find((candidate) => candidate.name === view);
  if (!selectedView) return { ok: false, error: "This element's topic is no longer in the governed model." };
  const members = new Map(selectedView.members.filter(member => !member.aiHidden).map((member) => [member.name, member] as const));
  let query: CubeQuery = base;

  for (const edit of edits) {
    switch (edit.op) {
      case "set_granularity": {
        if (!(query.timeDimensions ?? []).some((entry) => entry.dimension === edit.dimension)) {
          return { ok: false, error: "Truncate date needs a date column on this element." };
        }
        query = replaceTimeDimension(query, edit.dimension, (current) => ({ ...current, granularity: edit.granularity }));
        break;
      }
      case "set_date_range": {
        const member = members.get(edit.dimension);
        if (!member || member.kind !== "dimension" || member.type !== "time") {
          return { ok: false, error: "Date range needs a date column from this element's topic." };
        }
        const present = (query.timeDimensions ?? []).some((entry) => entry.dimension === edit.dimension);
        if (present) {
          query = replaceTimeDimension(query, edit.dimension, (current) => {
            const rest: Record<string, unknown> = { ...current };
            delete rest.dateRange;
            if (edit.dateRange === null) return Object.keys(rest).length > 1 ? rest as CubeTimeDimension : null;
            return { ...(rest as CubeTimeDimension), dateRange: edit.dateRange };
          });
        } else if (edit.dateRange !== null) {
          query = { ...query, timeDimensions: [...(query.timeDimensions ?? []), { dimension: edit.dimension, dateRange: edit.dateRange }] };
        }
        break;
      }
      case "set_compare": {
        if (!(query.timeDimensions ?? []).some((entry) => entry.dimension === edit.dimension)) {
          return { ok: false, error: "A comparison needs a date column on this element." };
        }
        query = replaceTimeDimension(query, edit.dimension, (current) => {
          const rest: Record<string, unknown> = { ...current };
          delete rest.compareDateRange;
          delete rest.dateRange;
          if (edit.compareDateRange === null) {
            return (current.dateRange ? { ...rest, dateRange: current.dateRange } : rest) as CubeTimeDimension;
          }
          // Cube takes either a window or a comparison of windows, never both.
          return { ...(rest as CubeTimeDimension), compareDateRange: edit.compareDateRange };
        });
        break;
      }
      case "add_measure": {
        const member = members.get(edit.member);
        if (!member || member.kind !== "measure") {
          return { ok: false, error: `${memberTitle(member, edit.member)} is not a calculation of this element's topic.` };
        }
        if ((query.measures ?? []).includes(edit.member)) break;
        if ((query.measures ?? []).length >= MAX_MEASURES) {
          return { ok: false, error: `An element shows at most ${MAX_MEASURES} calculations.` };
        }
        query = { ...query, measures: [...(query.measures ?? []), edit.member] };
        break;
      }
      case "remove_measure": {
        if (!(query.measures ?? []).includes(edit.member)) break;
        const measures = (query.measures ?? []).filter((name) => name !== edit.member);
        const rest: Record<string, unknown> = { ...query };
        delete rest.measures;
        query = withoutOrder((measures.length > 0 ? { ...rest, measures } : rest) as CubeQuery, edit.member);
        break;
      }
      case "add_dimension": {
        const member = members.get(edit.member);
        if (!member || member.kind !== "dimension") {
          return { ok: false, error: `${memberTitle(member, edit.member)} is not a column of this element's topic.` };
        }
        const alreadyTime = (query.timeDimensions ?? []).find((entry) => entry.dimension === edit.member);
        if (alreadyTime) {
          if (!alreadyTime.granularity) query = replaceTimeDimension(query, edit.member, current => ({ ...current, granularity: edit.granularity ?? "day" }));
          break;
        }
        if ((query.dimensions ?? []).includes(edit.member)) break;
        if ((query.dimensions ?? []).length + (query.timeDimensions ?? []).length >= MAX_DIMENSIONS) {
          return { ok: false, error: `An element groups by at most ${MAX_DIMENSIONS} columns.` };
        }
        if (member.type === "time") {
          query = {
            ...query,
            timeDimensions: [...(query.timeDimensions ?? []), { dimension: edit.member, granularity: edit.granularity ?? "day" }],
          };
        } else {
          query = { ...query, dimensions: [...(query.dimensions ?? []), edit.member] };
        }
        break;
      }
      case "remove_dimension": {
        const dimensions = (query.dimensions ?? []).filter((name) => name !== edit.member);
        const rest: Record<string, unknown> = { ...query };
        delete rest.dimensions;
        query = (dimensions.length > 0 ? { ...rest, dimensions } : rest) as CubeQuery;
        query = replaceTimeDimension(query, edit.member, () => null);
        query = withoutOrder(query, edit.member);
        break;
      }
      case "set_limit": {
        query = { ...query, limit: edit.limit };
        break;
      }
      default: {
        const unreachable: never = edit;
        return { ok: false, error: `Unsupported edit ${String(unreachable)}.` };
      }
    }
  }

  const shown = (query.measures?.length ?? 0) + (query.dimensions?.length ?? 0)
    + (query.timeDimensions ?? []).filter((entry) => entry.granularity).length;
  if (shown === 0) return { ok: false, error: "An element needs at least one column or calculation." };
  return { ok: true, query };
}

/** The granularity Cube would use for a bucket edit, checked against the view's floor. */
export function granularityAllowed(catalogue: CubeCatalogue, view: string, granularity: DashboardEditGranularity): boolean {
  const selectedView = catalogue.views.find((candidate) => candidate.name === view);
  const floor = selectedView?.minimumTimeGranularity;
  if (!floor || selectedView?.queryPolicy !== "aggregate_only") return true;
  return CUBE_GRANULARITIES.indexOf(granularity) >= CUBE_GRANULARITIES.indexOf(floor);
}
