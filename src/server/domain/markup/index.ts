// The P3 markup subset (tech-stack.md P3) for email and offer bodies: `#` and
// `##` headings, paragraphs separated by blank lines, `**bold**`, `*italic*`,
// `-` list items and line breaks. Anything else is plain text. Pure: the
// email service renders HTML from it (task 18) and the offer PDF renders the
// same blocks (task 37).

export type Inline = { text: string; bold: boolean; italic: boolean };
export type Block =
  | { kind: "heading"; level: 1 | 2; content: Inline[] }
  | { kind: "paragraph"; lines: Inline[][] }
  | { kind: "list"; items: Inline[][] };

/** Splits one line into text runs with bold and italic flags. */
export function parseInline(line: string): Inline[] {
  const runs: Inline[] = [];
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > last) runs.push({ text: line.slice(last, match.index), bold: false, italic: false });
    if (match[1] !== undefined) runs.push({ text: match[1], bold: true, italic: false });
    else runs.push({ text: match[2], bold: false, italic: true });
    last = match.index + match[0].length;
  }
  if (last < line.length) runs.push({ text: line.slice(last), bold: false, italic: false });
  return runs;
}

/** Parses a body into blocks. Line endings are normalised; blank lines separate blocks. */
export function parseMarkup(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: Inline[][] = [];
  let list: Inline[][] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", lines: paragraph });
    if (list.length > 0) blocks.push({ kind: "list", items: list });
    paragraph = [];
    list = [];
  };

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,2}) (.*)$/.exec(line);
    const item = /^- (.*)$/.exec(line);
    if (line.trim() === "") {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2, content: parseInline(heading[2]) });
    } else if (item) {
      if (paragraph.length > 0) flush();
      list.push(parseInline(item[1]));
    } else {
      if (list.length > 0) flush();
      paragraph.push(parseInline(line));
    }
  }
  flush();
  return blocks;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineHtml(runs: Inline[]): string {
  return runs
    .map((run) => {
      let html = escapeHtml(run.text);
      if (run.italic) html = `<em>${html}</em>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      return html;
    })
    .join("");
}

/**
 * HTML for a body. The author's text is escaped, so HTML in a template is
 * shown as text. `[[TOKEN]]` placeholders pass through unchanged, to be
 * resolved afterwards in `html` mode (values are then escaped, never markup).
 */
export function markupToHtml(text: string): string {
  return parseMarkup(text)
    .map((block) => {
      switch (block.kind) {
        case "heading":
          return `<h${block.level}>${inlineHtml(block.content)}</h${block.level}>`;
        case "paragraph":
          return `<p>${block.lines.map(inlineHtml).join("<br>\n")}</p>`;
        case "list":
          return `<ul>\n${block.items.map((item) => `<li>${inlineHtml(item)}</li>`).join("\n")}\n</ul>`;
      }
    })
    .join("\n");
}
