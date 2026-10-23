// The logo for `[[LOGO]]` in HTML emails (tech-stack.md P5): /public/logo.png
// as a data: URI, so it renders in Mailpit and the sandboxed Outbox iframe
// without fetching anything. Read once per process.
import { readFileSync } from "node:fs";
import path from "node:path";

let cached: string | undefined;

export function logoDataUri(): string {
  cached ??= `data:image/png;base64,${readFileSync(path.join(process.cwd(), "public", "logo.png")).toString("base64")}`;
  return cached;
}
