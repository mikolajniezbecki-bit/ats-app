// Requisition description allowlist (ats-project-scope.md §5.2): what the
// public job page may show.
import { describe, expect, it } from "vitest";
import { hasVisibleText, sanitizeDescription } from "@/server/domain/requisitions/description";

describe("sanitizeDescription", () => {
  it("keeps the allowed markup", () => {
    const html = "<h2>Role</h2><h3>Team</h3><p>We <strong>build</strong> <em>things</em>.<br />Join us.</p><ul><li>One</li></ul><ol><li>Two</li></ol>";
    expect(sanitizeDescription(html)).toBe(html);
  });

  it("removes <script> with its content and <iframe>", () => {
    expect(sanitizeDescription('<p>Hi</p><script>alert("x")</script><iframe src="https://example.com"></iframe>')).toBe("<p>Hi</p>");
  });

  it("removes event handlers and style attributes", () => {
    expect(sanitizeDescription('<p style="color:red" onclick="x()">Text</p><img src="x" onerror="alert(1)">')).toBe("<p>Text</p>");
  });

  it("removes javascript: links and keeps the text", () => {
    expect(sanitizeDescription('<p><a href="javascript:alert(1)">click</a></p>')).toBe("<p>click</p>");
  });

  it("rewrites allowed links to open safely in a new tab", () => {
    expect(sanitizeDescription('<a href="https://example.com" rel="opener" target="_self" class="x">site</a>')).toBe(
      '<a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">site</a>',
    );
    expect(sanitizeDescription('<a href="mailto:jobs@example.com">mail</a>')).toContain('href="mailto:jobs@example.com"');
    expect(sanitizeDescription('<a href="http://example.com">old</a>')).toContain('href="http://example.com"');
  });

  it("removes other tags such as h1, tables and divs but keeps their text", () => {
    expect(sanitizeDescription("<h1>Title</h1><div><table><tr><td>Cell</td></tr></table></div>")).toBe("TitleCell");
  });

  it("hasVisibleText ignores empty paragraphs", () => {
    expect(hasVisibleText("<p></p><p>&nbsp;</p><br>")).toBe(false);
    expect(hasVisibleText("<p>Hello</p>")).toBe(true);
  });
});
