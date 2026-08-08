/**
 * Shared humanisation of governed / dotted identifiers for traces and answers.
 */

const governedTermAcronyms = new Map([
  ["gst", "GST"],
  ["pos", "POS"],
  ["sku", "SKU"],
  ["abn", "ABN"],
  ["aud", "AUD"],
  ["id", "ID"],
  ["pct", "%"],
]);

export function governedTerm(value: string): string {
  return value
    .slice(value.lastIndexOf(".") + 1)
    .split("_")
    .filter(Boolean)
    .map((word) => governedTermAcronyms.get(word.toLowerCase()) ?? word)
    .join(" ")
    .trim();
}

/** Joins already-human trace fragments, keeping the line short and bounded. */
export function traceList(values: readonly string[], max = 3): string {
  const items = [...new Set(values.filter(Boolean))];
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

export function governedTermList(values: readonly string[], max = 3): string {
  return traceList(values.map(governedTerm), max);
}
