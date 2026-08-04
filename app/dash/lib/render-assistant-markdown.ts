type LinkMode = "anchor" | "text";

interface RenderAssistantMarkdownOptions {
  compact?: boolean;
  linkMode?: LinkMode;
}

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
  return trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTableRow(line: string): boolean {
  return splitTableRow(line).length >= 2;
}

function isTableSeparator(line: string): boolean {
  return isTableRow(line) && splitTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell));
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
  const head = headers.map((cell) => `<th>${renderInlineMarkdown(cell, options.linkMode)}</th>`).join("");
  const body = rows.map((row) => {
    const cells = row.map((cell) => `<td>${renderInlineMarkdown(cell, options.linkMode)}</td>`).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Bike Insights New / Genie markdown renderer, adapted for Albert answers. */
export function renderAssistantMarkdown(
  markdown: string,
  options: RenderAssistantMarkdownOptions = {},
): string {
  const resolved: Required<RenderAssistantMarkdownOptions> = {
    compact: options.compact ?? false,
    linkMode: options.linkMode ?? "anchor",
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

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(renderHeading(heading[1]!.length, heading[2]!, resolved));
      index += 1;
      continue;
    }

    if (isTableRow(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1]!)) {
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

    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const items: string[] = [];
      const isOrdered = Boolean(ordered);
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = isOrdered
          ? /^\d+[.)]\s+(.+)$/.exec(current)
          : /^[-*]\s+(.+)$/.exec(current);
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
      if (/^#{1,6}\s+/.test(next) || isTableRow(next) || /^[-*]\s+/.test(next) || /^\d+[.)]\s+/.test(next)) {
        break;
      }
      paragraph.push(next);
      index += 1;
    }
    blocks.push(renderParagraph(paragraph.join(" "), resolved));
  }

  return blocks.join("");
}
