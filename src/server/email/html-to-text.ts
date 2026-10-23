// The text part of an email from its HTML part (tech-stack.md §9). Pure and
// made for the HTML the markup renderer and the footer produce: block
// elements become line breaks, list items get "- ", the logo is dropped and
// entities are decoded.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

export function htmlToText(html: string): string {
  return html
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>\n?/gi, "\n")
    .replace(/<hr\s*\/?>\n?/gi, "\n---\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(p|h[1-6]|ul|ol|div)>\n?/gi, "\n\n")
    .replace(/<\/li>\n?/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_entity, name: string) => ENTITIES[name])
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
