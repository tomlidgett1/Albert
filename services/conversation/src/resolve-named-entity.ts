/**
 * Fuzzy business-name resolution for dumbed-down owner questions.
 * "gen services" → patterns that match "Service - General Service", ranked by
 * recent sales so Albert can lightly assume the store's real product.
 *
 * This tool surfaces candidates and a suggested reading. It does not decide
 * product-class vs single-SKU intent for the model; the agent must reason
 * (categories, aggregates, one item) from the question and the candidate set.
 */

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "our", "we",
  "have", "has", "had", "sold", "sale", "sales", "how", "many", "much", "this",
  "that", "month", "week", "year", "today", "ytd",
]);

/** Common retail / workshop shorthand → catalogue spellings (search only). */
const TOKEN_EXPANSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  gen: ["general", "gen", "generation"],
  general: ["general", "gen"],
  svc: ["service", "services", "svc"],
  service: ["service", "services"],
  services: ["service", "services"],
  srv: ["service", "services"],
  brk: ["brake", "brakes"],
  brake: ["brake", "brakes"],
  brakes: ["brake", "brakes"],
  tyre: ["tyre", "tyres", "tire", "tires"],
  tyres: ["tyre", "tyres", "tire", "tires"],
  tire: ["tyre", "tyres", "tire", "tires"],
  tires: ["tyre", "tyres", "tire", "tires"],
  bike: ["bike", "bicycle", "bikes"],
  bikes: ["bike", "bicycle", "bikes"],
  ebike: ["e-bike", "ebike", "electric"],
  "e-bike": ["e-bike", "ebike", "electric"],
  glass: ["glass", "glasses", "sunglass", "sunglasses"],
  glasses: ["glass", "glasses", "sunglass", "sunglasses"],
  sunglass: ["sunglass", "sunglasses", "glass", "glasses"],
  sunglasses: ["sunglass", "sunglasses", "glass", "glasses"],
});

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (char) => `\\${char}`);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

export function tokenizeBusinessPhrase(phrase: string): readonly string[] {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gu, " ")
    .split(/[\s-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

export function expandToken(token: string): readonly string[] {
  const direct = TOKEN_EXPANSIONS[token];
  if (direct) return direct;
  // Strip trailing plural s for a light second try.
  if (token.endsWith("s") && token.length > 3) {
    const singular = token.slice(0, -1);
    const expanded = TOKEN_EXPANSIONS[singular];
    if (expanded) return expanded;
  }
  return [token];
}

/**
 * Build AND-of-OR ILIKE groups so "gen services" matches descriptions that
 * contain a gen/general token and a service/services token (any order).
 */
export function buildDescriptionMatchSql(
  phrase: string,
  columnSql = "i.description",
): Readonly<{ sql: string; tokens: readonly string[]; expansions: readonly (readonly string[])[] }> {
  const tokens = tokenizeBusinessPhrase(phrase);
  if (tokens.length === 0) {
    const fallback = phrase.trim().toLowerCase();
    const pattern = `%${escapeLike(fallback)}%`;
    return {
      sql: `${columnSql} ILIKE ${sqlString(pattern)} ESCAPE '\\'`,
      tokens: fallback ? [fallback] : [],
      expansions: fallback ? [[fallback]] : [],
    };
  }
  const expansions = tokens.map((token) => expandToken(token));
  const groups = expansions.map((forms) => {
    const ors = forms.map((form) => `${columnSql} ILIKE ${sqlString(`%${escapeLike(form)}%`)} ESCAPE '\\'`);
    return `(${ors.join(" OR ")})`;
  });
  return {
    sql: groups.join(" AND "),
    tokens,
    expansions,
  };
}

/**
 * Rank Lightspeed catalogue items that match a fuzzy phrase by units sold this
 * calendar month in each sale's shop timezone, then all-time completed sales.
 * Applies the three playbook gates: tombstone filter, pack pin by ingest
 * recency on every table, and completed AND NOT voided on the sale. `archived`
 * is deliberately NOT filtered — an archived completed sale was real revenue.
 */
export function buildItemResolveSql(phrase: string, limit = 12): string {
  const match = buildDescriptionMatchSql(phrase, "i.description");
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 25);
  return `
WITH pack AS (
  SELECT mapping_version AS mv
  FROM source_lightspeed.ls_sales
  GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
)
SELECT
  i.item_id::text AS item_id,
  i.description AS item_name,
  COALESCE(SUM(CASE
    WHEN s.sale_id IS NOT NULL
      AND sh.time_zone IS NOT NULL
      AND s.complete_time >= (date_trunc('month', now() AT TIME ZONE sh.time_zone) AT TIME ZONE sh.time_zone)
    THEN sl.unit_quantity::numeric
    ELSE 0
  END), 0) AS units_this_month,
  COALESCE(SUM(CASE WHEN s.sale_id IS NOT NULL THEN sl.unit_quantity::numeric ELSE 0 END), 0) AS units_all_time
FROM source_lightspeed.ls_items AS i
LEFT JOIN source_lightspeed.ls_sale_lines AS sl
  ON sl.item_id = i.item_id
 AND sl.tombstone = false
 AND sl.mapping_version = (SELECT mv FROM pack)
LEFT JOIN source_lightspeed.ls_sales AS s
  ON s.sale_id = sl.sale_id
 AND s.tombstone = false
 AND s.mapping_version = (SELECT mv FROM pack)
 AND s.completed = true
 AND s.voided = false
LEFT JOIN source_lightspeed.ls_shops AS sh
  ON sh.shop_id = s.shop_id
 AND sh.tombstone = false
 AND sh.mapping_version = (SELECT mv FROM pack)
WHERE i.tombstone = false
  AND i.mapping_version = (SELECT mv FROM pack)
  AND (${match.sql})
GROUP BY i.item_id, i.description
ORDER BY units_this_month DESC, units_all_time DESC, item_name ASC
LIMIT ${safeLimit}
`.trim();
}

export type NamedEntityCandidate = Readonly<{
  itemId: string;
  itemName: string;
  unitsThisMonth: number;
  unitsAllTime: number;
}>;

export type NamedEntityResolution = Readonly<{
  phrase: string;
  tokens: readonly string[];
  /** Suggested single-SKU reading when confidence warrants it; never a hard route. */
  assumption: NamedEntityCandidate | null;
  confidence: "high" | "medium" | "low" | "none";
  reason: string;
  candidates: readonly NamedEntityCandidate[];
  nextStep: string;
}>;

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function candidatesFromResolveRows(
  rows: readonly Readonly<Record<string, unknown>>[],
): readonly NamedEntityCandidate[] {
  return rows.map((row) => ({
    itemId: String(row.item_id ?? "").trim(),
    itemName: String(row.item_name ?? "").trim(),
    unitsThisMonth: asNumber(row.units_this_month),
    unitsAllTime: asNumber(row.units_all_time),
  })).filter((row) => row.itemId && row.itemName);
}

/** True when form appears as its own word, not as a substring of a longer word. */
export function nameContainsForm(name: string, form: string): boolean {
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/gu, (char) => `\\${char}`);
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "iu").test(name);
}

function hasDominantSku(
  top: NamedEntityCandidate,
  second: NamedEntityCandidate | undefined,
): boolean {
  if (!second) return true;
  if (top.unitsThisMonth > 0 && top.unitsThisMonth >= Math.max(2, second.unitsThisMonth * 2)) {
    return true;
  }
  if (
    top.unitsThisMonth === 0
    && top.unitsAllTime > 0
    && top.unitsAllTime >= Math.max(2, second.unitsAllTime * 2)
  ) {
    return true;
  }
  return false;
}

/**
 * Rank catalogue matches and suggest a reading. When several peers look equally
 * plausible, leave confidence low and tell the model to decide intent (category,
 * aggregate, or one SKU) rather than forcing a single item_id.
 */
export function chooseNamedEntityAssumption(
  phrase: string,
  candidates: readonly NamedEntityCandidate[],
): NamedEntityResolution {
  const tokens = tokenizeBusinessPhrase(phrase);
  if (candidates.length === 0) {
    return {
      phrase,
      tokens,
      assumption: null,
      confidence: "none",
      reason: "No catalogue items matched that wording.",
      candidates: [],
      nextStep:
        "Try source_lightspeed.ls_categories (name / full_path_name) or a broader ILIKE on ls_items.description, "
        + "or ask which product they mean.",
    };
  }

  const ranked = [...candidates].sort((left, right) => {
    if (right.unitsThisMonth !== left.unitsThisMonth) return right.unitsThisMonth - left.unitsThisMonth;
    if (right.unitsAllTime !== left.unitsAllTime) return right.unitsAllTime - left.unitsAllTime;
    return left.itemName.localeCompare(right.itemName);
  });
  const top = ranked[0]!;
  const second = ranked[1];
  const examples = ranked.slice(0, 3).map((item) => item.itemName).join("; ");
  const peerSet = ranked.length >= 3 && !hasDominantSku(top, second);

  // Many peer SKUs: do not steer the model onto the top row. Present options.
  if (peerSet) {
    return {
      phrase,
      tokens,
      assumption: null,
      confidence: "low",
      reason:
        `Several catalogue items match “${phrase}” with no clear single-SKU leader `
        + `(e.g. ${examples}). Intent is for you to decide.`,
      candidates: ranked.slice(0, 8),
      nextStep:
        `Do not count only the top item_id. Decide from the owner's question: `
        + `(1) product type/family → join ls_items.category_id to source_lightspeed.ls_categories `
        + `(name / full_path_name live there, not on the item row), and/or aggregate completed sales `
        + `across all matching item descriptions; (2) one specific product → pick the best SKU and disclose it. `
        + `Categories first when the wording is a type of goods (glasses, tyres, helmets, etc.).`,
    };
  }

  const name = top.itemName.toLowerCase();
  const expansions = tokens.map((token) => expandToken(token));
  const coversAllTokens = expansions.every((forms) => forms.some((form) => nameContainsForm(name, form)));

  let confidence: NamedEntityResolution["confidence"] = "medium";
  let reason = `Closest catalogue match by recent sales: ${top.itemName}.`;

  if (hasDominantSku(top, second) && top.unitsThisMonth > 0) {
    confidence = "high";
    reason = `${top.itemName} is the clear volume leader this month for that wording (${top.unitsThisMonth} units).`;
  } else if (hasDominantSku(top, second) && top.unitsAllTime > 0) {
    confidence = "high";
    reason = `${top.itemName} leads all-time sales for that wording (${top.unitsAllTime} units).`;
  } else if (coversAllTokens && top.unitsThisMonth + top.unitsAllTime > 0) {
    confidence = "high";
    reason = `${top.itemName} matches the wording and has sales history.`;
  } else if (coversAllTokens) {
    confidence = "medium";
    reason = `${top.itemName} matches the wording best, though recent sales are thin.`;
  } else if (ranked.length > 1) {
    confidence = "low";
    reason = "Matches are weak or split; confirm intent before treating one SKU as definitive.";
  }

  return {
    phrase,
    tokens,
    assumption: confidence === "low" ? null : top,
    confidence,
    reason,
    candidates: ranked.slice(0, 8),
    nextStep: confidence === "low"
      ? `Candidates include: ${examples}. Decide whether this is one SKU, a category `
        + `(ls_categories via ls_items.category_id), or an aggregate across matches before counting.`
      : `Suggested reading: item_id ${top.itemId} (${top.itemName}). `
        + `Only use that single SKU if the question is about that product. `
        + `If the owner meant a type of goods, check categories or aggregate matching items instead, and disclose what you counted.`,
  };
}
