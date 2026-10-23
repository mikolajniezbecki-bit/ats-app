// Requisition description (ats-project-scope.md §5.2): rich text from the
// editor, sanitized with an allowlist on save and again on display, because
// it is shown on the public job page. Anything outside the allowlist is
// removed; links open in a new tab without referrer or opener.
import sanitizeHtml from "sanitize-html";

export const MAX_DESCRIPTION_LENGTH = 50_000;

const SAFE_HREF = /^(https?:|mailto:)/i;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "h2", "h3", "strong", "em", "ul", "ol", "li", "a"],
  // rel and target are always overwritten by the transform below.
  allowedAttributes: { a: ["href", "rel", "target"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  // Script and style contents are dropped with their tags, not kept as text.
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object"],
  // A link without an allowed scheme becomes a span, which is then dropped
  // with its text kept; the scheme filter still checks the kept hrefs.
  transformTags: {
    a: (tagName, attribs): sanitizeHtml.Tag =>
      attribs.href && SAFE_HREF.test(attribs.href.trim())
        ? { tagName, attribs: { href: attribs.href.trim(), rel: "noopener noreferrer nofollow", target: "_blank" } }
        : { tagName: "span", attribs: {} },
  },
};

/** The description with only the allowed markup left. */
export function sanitizeDescription(html: string): string {
  return sanitizeHtml(html, OPTIONS).trim();
}

/** True when the HTML shows any text (A1 needs it on submit; empty paragraphs don't count). */
export function hasVisibleText(html: string): boolean {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/&nbsp;|\s/g, "").length > 0;
}
