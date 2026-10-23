// Message texts for API responses, from the same messages/en.json the UI uses
// (single locale, tradeoffs.md TO-06). Route handlers run outside a page, so
// they read the file directly; `{name}` placeholders are filled from `params`.
import messages from "../../messages/en.json";

/** The text at a dotted path such as `AdminMasterData.errors.duplicate`; throws for a missing one. */
export function message(path: string, params: Record<string, string> = {}): string {
  let value: unknown = messages;
  for (const part of path.split(".")) {
    value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[part] : undefined;
  }
  if (typeof value !== "string") throw new Error(`No message ${path}`);
  return value.replace(/\{(\w+)\}/g, (placeholder, name: string) => params[name] ?? placeholder);
}
