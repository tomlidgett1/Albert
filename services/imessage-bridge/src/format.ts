import type { LinqTextDecoration } from "./linq.js";

/**
 * Turns an Omni markdown answer into iMessage bubbles: plain text plus Linq
 * v3 text decorations. The imessage channel prompt already asks the model
 * for text-message form; this pass is the deterministic backstop that keeps
 * any residual markdown (tables, headings, list markers, links) from
 * reaching the phone as literal syntax. Adapted from the production Nest
 * agent's outbound normalisation, which has run against Linq v3 since 2026.
 */

export type ImessageBubble = Readonly<{
  text: string;
  decorations: readonly LinqTextDecoration[];
}>;

const MAX_BUBBLES = 3;
/** Linq caps a text part at 10,000 characters; stay well inside it. */
const MAX_BUBBLE_CHARS = 9_500;

function isTableDivider(line: string): boolean {
  // A bare --- line is a bubble separator, never a table divider; markdown
  // table divider rows always carry at least one pipe.
  if (!line.includes("|")) return false;
  const inner = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return inner.length > 0 && /^[\s:|-]+$/u.test(inner) && inner.includes("-");
}

function tableCells(line: string): string[] {
  return line.trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** One markdown table row becomes "label: value · value" on a single line. */
function tableRowToLine(cells: readonly string[]): string {
  const [label, ...rest] = cells;
  const values = rest.filter((cell) => cell.length > 0);
  if (!label) return values.join(" · ");
  if (values.length === 0) return label;
  return `${label}: ${values.join(" · ")}`;
}

function convertStructure(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    // Follow-up link menus never belong in a text message.
    if (/^\[[^\]]+\]\(\?ai-query=/u.test(trimmed)) continue;
    if (isTableDivider(trimmed)) continue;
    if (trimmed.startsWith("|") && trimmed.includes("|", 1)) {
      const cells = tableCells(trimmed);
      const isHeader = index + 1 < lines.length && isTableDivider(lines[index + 1]!.trim());
      if (isHeader) {
        out.push(`**${cells.filter(Boolean).join(" · ")}**`);
      } else {
        out.push(tableRowToLine(cells));
      }
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/u.exec(trimmed);
    if (heading) {
      out.push(`**${heading[1]!.replace(/\*\*/gu, "").trim()}**`);
      continue;
    }
    out.push(line
      .replace(/^(\s*)[-*+]\s+/u, "$1• ")
      .replace(/^(\s*)(\d{1,2})\.\s+/u, "$1$2. "));
  }
  return out.join("\n");
}

function cleanForTexting(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gu, "")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|\?)[^)]*\)/gu, "$1")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/—/gu, "-")
    .replace(/–/gu, "-")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * Parses **bold** and *italic* markers out of the cleaned text, returning the
 * delivered string and Linq text_decorations with [start, end) UTF-16 ranges.
 * Unmatched markers stay literal; italic markers never fire across
 * whitespace boundaries (so "5 * 3" survives).
 */
export function extractTextDecorations(input: string): {
  value: string;
  decorations: LinqTextDecoration[];
} {
  const decorations: LinqTextDecoration[] = [];
  let out = "";
  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    if (char === "*" && input[index + 1] === "*") {
      const close = input.indexOf("**", index + 2);
      if (close > index + 2) {
        const inner = input.slice(index + 2, close);
        if (inner.length > 0 && !/^\s|\s$/u.test(inner) && !inner.includes("\n\n")) {
          const start = out.length;
          out += inner;
          decorations.push({ range: [start, out.length], style: "bold" });
          index = close + 2;
          continue;
        }
      }
    }
    if (
      char === "*"
      && input[index + 1] !== undefined
      && input[index + 1] !== "*"
      && !/\s/u.test(input[index + 1]!)
    ) {
      let scan = index + 1;
      let found = -1;
      while (scan < input.length) {
        const candidate = input[scan]!;
        if (candidate === "\n") break;
        if (candidate === "*" && input[scan + 1] !== "*" && !/\s/u.test(input[scan - 1]!)) {
          found = scan;
          break;
        }
        scan += 1;
      }
      if (found > index + 1) {
        const inner = input.slice(index + 1, found);
        const start = out.length;
        out += inner;
        decorations.push({ range: [start, out.length], style: "italic" });
        index = found + 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return { value: out, decorations };
}

/** Formats one Omni answer into at most three ordered iMessage bubbles. */
export function formatAnswerForImessage(markdown: string): readonly ImessageBubble[] {
  const converted = cleanForTexting(convertStructure(markdown));
  if (!converted) return Object.freeze([]);
  const sections = converted
    .split(/\n\s*-{3,}\s*\n/u)
    .map((section) => section.trim())
    .filter((section) => section.length > 0);
  const merged = sections.slice(0, MAX_BUBBLES);
  if (sections.length > MAX_BUBBLES) {
    merged[MAX_BUBBLES - 1] = [merged[MAX_BUBBLES - 1]!, ...sections.slice(MAX_BUBBLES)].join("\n\n");
  }
  return Object.freeze(merged.map((section) => {
    const { value, decorations } = extractTextDecorations(section);
    const text = value.length > MAX_BUBBLE_CHARS ? `${value.slice(0, MAX_BUBBLE_CHARS - 1)}…` : value;
    return Object.freeze({
      text,
      decorations: Object.freeze(decorations.filter((decoration) => decoration.range[1] <= text.length)),
    });
  }));
}
