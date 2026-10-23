// Private posting slug (ats-project-scope.md L9): 32 random lower-case hex
// characters, generated on save when a PRIVATE posting has none.
import { randomBytes } from "node:crypto";

export const PRIVATE_SLUG_PATTERN = /^[0-9a-f]{32}$/;

export function generatePrivateSlug(): string {
  return randomBytes(16).toString("hex");
}
