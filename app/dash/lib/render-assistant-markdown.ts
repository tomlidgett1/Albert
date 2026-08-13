type LinkMode = "anchor" | "text";

interface RenderAssistantMarkdownOptions {
  compact?: boolean;
  linkMode?: LinkMode;
  /** Optional HTML (icons) appended inside the last header cell of each data table. */
  tableSourceBadgesHtml?: string;
}

export type AssistantMarkdownSections = Readonly<{
  lead: string;
  detail: string;
}>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderEmphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+?)\*/g, "<em>$1</em>");
}

function renderBareUrls(escaped: string, linkMode: LinkMode): string {
  const urlPattern = /https?:\/\/[^\s<]+/g;
  if (linkMode === "text") return escaped.replace(urlPattern, "");
  return escaped.replace(urlPattern, (url) => {
    const trimmedUrl = url.replace(/[.,;:!?)]$/, "");
    const trailing = url.slice(trimmedUrl.length);
    return `<a href="${trimmedUrl}" target="_blank" rel="noreferrer">${trimmedUrl}</a>${trailing}`;
  });
}

function renderTextSegment(segment: string, linkMode: LinkMode): string {
  const markdownLinkPattern = /\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g;
  let output = "";
  let lastIndex = 0;
  for (const match of segment.matchAll(markdownLinkPattern)) {
    const index = match.index ?? 0;
    output += renderBareUrls(renderEmphasis(escapeHtml(segment.slice(lastIndex, index))), linkMode);
    const label = renderEmphasis(escapeHtml(match[1]!));
    const href = escapeHtml(match[2]!);
    output += linkMode === "anchor"
      ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`
      : label;
    lastIndex = index + match[0].length;
  }
  output += renderBareUrls(renderEmphasis(escapeHtml(segment.slice(lastIndex))), linkMode);
  return output;
}

function renderInlineMarkdown(value: string, linkMode: LinkMode): string {
  const codePattern = /`([^`]+?)`/g;
  let output = "";
  let lastIndex = 0;
  for (const match of value.matchAll(codePattern)) {
    const index = match.index ?? 0;
    output += renderTextSegment(value.slice(lastIndex, index), linkMode);
    output += `<code>${escapeHtml(match[1]!)}</code>`;
    lastIndex = index + match[0].length;
  }
  output += renderTextSegment(value.slice(lastIndex), linkMode);
  return output;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  return trimmed
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    // A governed label may contain a pipe ("700x25c | Black"); the author
    // escapes it, and an escaped pipe is data rather than a column boundary.
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function isTableRow(line: string): boolean {
  return splitTableRow(line).length >= 2;
}

/**
 * GitHub-flavoured markdown needs only one dash per column, and models write
 * every width — `|---|`, `|--|`, `|-|`, `|:-:|`. Demanding three silently
 * turned a whole table back into loose pipes.
 */
function isTableSeparator(line: string): boolean {
  return isTableRow(line) && splitTableRow(line).every((cell) => /^:?-+:?$/.test(cell));
}

/** A table opens only where a header row is followed by its separator. */
function startsTable(lines: readonly string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];
  return header !== undefined
    && separator !== undefined
    && isTableRow(header)
    && isTableSeparator(separator);
}

function renderHeading(level: number, text: string, options: Required<RenderAssistantMarkdownOptions>): string {
  const content = renderInlineMarkdown(text, options.linkMode);
  if (options.compact) return `<p><strong>${content}</strong></p>`;
  if (level <= 1) return `<h1>${content}</h1>`;
  if (level === 2) return `<h2>${content}</h2>`;
  return `<h3>${content}</h3>`;
}

function renderParagraph(text: string, options: Required<RenderAssistantMarkdownOptions>): string {
  return `<p>${renderInlineMarkdown(text, options.linkMode)}</p>`;
}

function renderList(items: string[], ordered: boolean, options: Required<RenderAssistantMarkdownOptions>): string {
  const tag = ordered ? "ol" : "ul";
  const body = items.map((item) => `<li>${renderInlineMarkdown(item, options.linkMode)}</li>`).join("");
  return `<${tag}>${body}</${tag}>`;
}

function renderTable(headers: string[], rows: string[][], options: Required<RenderAssistantMarkdownOptions>): string {
  const badges = options.tableSourceBadgesHtml.trim();
  const head = headers.map((cell, index) => {
    const label = renderInlineMarkdown(cell, options.linkMode);
    const isLast = index === headers.length - 1;
    if (!isLast || !badges) return `<th>${label}</th>`;
    return `<th><span class="answerTableHeaderRow"><span class="answerTableHeaderLabel">${label}</span>${badges}</span></th>`;
  }).join("");
  const body = rows.map((row) => {
    // A ragged row must not shift its neighbours' figures into the wrong
    // column: pad short rows and drop cells past the last header.
    const cells = headers
      .map((_, column) => `<td>${renderInlineMarkdown(row[column] ?? "", options.linkMode)}</td>`)
      .join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  // Data tables are wider than a chat column. Scrolling the table keeps the
  // figures legible instead of crushing every column to fit.
  return `<div class="answerTableScroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// Leading indentation is tolerated: a model that indents a list or a heading
// still meant one, and a literal "- Services" in the prose helps nobody.
const headingPattern = /^\s*(#{1,6})\s+(.+)$/;
const unorderedItemPattern = /^\s*[-*]\s+(.+)$/;
const orderedItemPattern = /^\s*\d+[.)]\s+(.+)$/;

/**
 * Older saved answers sometimes contain human-looking section labels without
 * Markdown markers ("What is sound", "Issues to fix"). Promote only familiar
 * report cues that occupy their own paragraph; arbitrary product names and
 * one-line answers must remain prose.
 */
const implicitSectionCuePattern = /^(?:summary|overview|headline|the\s+bottom\s+line|key\s+(?:findings|takeaways|issues|risks|opportunities)|what\s+(?:is\s+sound|looks\s+(?:sound|good)|stands\s+out|needs\s+attention|to\s+(?:fix|confirm|fix\s+or\s+confirm)|is\s+not\s+covered|was\s+not\s+covered|is\s+missing)|issues?(?:\s+to\s+fix\s+or\s+confirm)?|problems?|risks?|opportunities?|recommendations?|actions?|priorities?|priority\s+actions?|prioritised\s+actions?|next\s+steps?|limitations?|caveats?|data\s+gaps?|gaps?|not\s+covered|highest-impact\s+actions?)$/iu;

function isImplicitSectionHeading(lines: readonly string[], index: number): boolean {
  const line = (lines[index] ?? "").trim();
  if (!line || line.length > 64 || !/^[A-Z]/u.test(line)) return false;
  if (/[.!?;:]$/u.test(line) || /[|`<>]/u.test(line)) return false;
  if (line.split(/\s+/u).length > 9 || !implicitSectionCuePattern.test(line)) return false;

  // It must be a standalone paragraph followed by real answer content. The
  // exact cue allowlist keeps an isolated business entity as normal prose; a
  // leading cue is allowed because table placement may render report detail as
  // a separate Markdown fragment.
  if (index >= lines.length - 1) return false;
  if ((index > 0 && (lines[index - 1] ?? "").trim()) || (lines[index + 1] ?? "").trim()) return false;
  const hasContentAfter = lines.slice(index + 1).some((candidate) => candidate.trim());
  return hasContentAfter;
}

/**
 * Separates the opening takeaway from a longer report at its first semantic
 * section. Structured answer tables can then sit directly after the takeaway,
 * matching the reading order promised by the answer contract.
 */
export function splitAssistantMarkdownLead(markdown: string): AssistantMarkdownSections {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (headingPattern.test(lines[index] ?? "") || isImplicitSectionHeading(lines, index)) {
      const lead = lines.slice(0, index).join("\n").trim();
      // The table belongs after an opening takeaway, never between two sections
      // when the model started the answer with a heading.
      if (!lead) return { lead: markdown.trim(), detail: "" };
      return {
        lead,
        detail: lines.slice(index).join("\n").trim(),
      };
    }
  }
  return { lead: markdown.trim(), detail: "" };
}

/** Bike Insights New / Genie markdown renderer, adapted for Albert answers. */
export function renderAssistantMarkdown(
  markdown: string,
  options: RenderAssistantMarkdownOptions = {},
): string {
  const resolved: Required<RenderAssistantMarkdownOptions> = {
    compact: options.compact ?? false,
    linkMode: options.linkMode ?? "anchor",
    tableSourceBadgesHtml: options.tableSourceBadgesHtml ?? "",
  };
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = headingPattern.exec(line);
    if (heading) {
      blocks.push(renderHeading(heading[1]!.length, heading[2]!, resolved));
      index += 1;
      continue;
    }

    if (!resolved.compact && isImplicitSectionHeading(lines, index)) {
      blocks.push(renderHeading(2, line.trim(), resolved));
      index += 1;
      continue;
    }

    if (startsTable(lines, index)) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index]!)) {
        rows.push(splitTableRow(lines[index]!));
        index += 1;
      }
      blocks.push(renderTable(headers, rows, resolved));
      continue;
    }

    const unordered = unorderedItemPattern.exec(line);
    const ordered = orderedItemPattern.exec(line);
    if (unordered || ordered) {
      const items: string[] = [];
      const isOrdered = Boolean(ordered);
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = isOrdered
          ? orderedItemPattern.exec(current)
          : unorderedItemPattern.exec(current);
        if (!match) break;
        items.push(match[1]!);
        index += 1;
      }
      blocks.push(renderList(items, isOrdered, resolved));
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (!next.trim()) break;
      // Only a real table header interrupts a paragraph. A sentence that
      // happens to contain a pipe is prose, not the start of a table.
      if (
        headingPattern.test(next)
        || (!resolved.compact && isImplicitSectionHeading(lines, index))
        || startsTable(lines, index)
        || unorderedItemPattern.test(next)
        || orderedItemPattern.test(next)
      ) {
        break;
      }
      paragraph.push(next);
      index += 1;
    }
    blocks.push(renderParagraph(paragraph.join(" "), resolved));
  }

  return blocks.join("");
}
