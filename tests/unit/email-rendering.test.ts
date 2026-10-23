// Email rendering without a database (tech-stack.md §9, P3 subset): markup to
// HTML with the author's text escaped, the text part, and error sanitizing.
import { describe, expect, it } from "vitest";
import { markupToHtml, parseMarkup } from "@/server/domain/markup";
import { resolveTokens } from "@/server/domain/tokens";
import { htmlToText } from "@/server/email/html-to-text";
import { sanitizeError } from "@/server/email/send";

describe("markupToHtml", () => {
  it("renders headings, paragraphs with line breaks, bold, italic and lists", () => {
    const body = "# Title\n## Sub\n\nFirst line\nsecond **bold** and *italic*\n\n- one\n- **two**";
    expect(markupToHtml(body)).toBe(
      "<h1>Title</h1>\n<h2>Sub</h2>\n<p>First line<br>\nsecond <strong>bold</strong> and <em>italic</em></p>\n<ul>\n<li>one</li>\n<li><strong>two</strong></li>\n</ul>",
    );
  });

  it("shows HTML in a template as text", () => {
    expect(markupToHtml('<script>alert("x")</script> & co')).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co</p>");
  });

  it("treats anything else as plain text: ### headings, numbered lists, unmatched stars", () => {
    expect(markupToHtml("### Three\n1. item\n2 * 3")).toBe("<p>### Three<br>\n1. item<br>\n2 * 3</p>");
  });

  it("keeps tokens intact for the HTML-mode resolver, so a value never becomes markup", () => {
    const html = markupToHtml("Dear **[[CANDIDATE_FULL_NAME]]**");
    expect(resolveTokens(html, { CANDIDATE_FULL_NAME: "**<i>x</i>**" }, "html")).toBe("<p>Dear <strong>**&lt;i&gt;x&lt;/i&gt;**</strong></p>");
  });

  it("parses into blocks that a PDF renderer can reuse", () => {
    expect(parseMarkup("Hi\r\n\r\n- a")).toEqual([
      { kind: "paragraph", lines: [[{ text: "Hi", bold: false, italic: false }]] },
      { kind: "list", items: [[{ text: "a", bold: false, italic: false }]] },
    ]);
  });
});

describe("htmlToText", () => {
  it("turns blocks into lines, lists into dashes, drops the logo and decodes entities", () => {
    const html = '<p><img src="data:image/png;base64,AA" alt="Logo"></p>\n<h1>Title</h1>\n<p>A &amp; B &lt;x&gt;<br>\nnext</p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<hr>\n<p>r@ats-demo.local<br>\nReply here.</p>';
    expect(htmlToText(html)).toBe("Title\n\nA & B <x>\nnext\n\n- one\n- two\n\n---\nr@ats-demo.local\nReply here.");
  });
});

describe("sanitizeError", () => {
  it("keeps the error class and SMTP or system code, never the message", () => {
    expect(sanitizeError(Object.assign(new Error("550 jane@example.com unknown"), { responseCode: 550 }))).toBe("Error: 550");
    expect(sanitizeError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:1025"), { code: "ECONNREFUSED" }))).toBe("Error: ECONNREFUSED");
    expect(sanitizeError(Object.assign(new TypeError("bad jane@example.com"), { code: "jane@example.com" }))).toBe("TypeError");
    expect(sanitizeError("weird")).toBe("Error");
  });
});
