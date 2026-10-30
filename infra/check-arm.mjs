// Fails if the compiled ARM template mentions a variable that must never be
// set in Azure (task 44): dev sign-in and its password, the Azurite
// connection settings and SMTP. infra.yml runs it on the output of
// `az bicep build`:
//
//   node infra/check-arm.mjs infra/main.json
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FORBIDDEN_NAMES = [
  "AUTH_DEV_LOGIN",
  "DEMO_USER_PASSWORD",
  "AZURE_STORAGE_CONNECTION_STRING",
  "AZURE_STORAGE_PUBLIC_URL",
  "SMTP_HOST",
  "SMTP_PORT",
];

/** The forbidden names that appear in `text`, as whole words. */
export function forbiddenNamesIn(text) {
  return FORBIDDEN_NAMES.filter((name) => new RegExp(`(^|[^A-Z0-9_])${name}([^A-Z0-9_]|$)`).test(text));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node infra/check-arm.mjs <compiled ARM JSON>");
    process.exit(2);
  }
  const found = forbiddenNamesIn(readFileSync(file, "utf8"));
  if (found.length > 0) {
    console.error(`${file} must not set: ${found.join(", ")}`);
    process.exit(1);
  }
  console.log(`${file}: none of ${FORBIDDEN_NAMES.join(", ")} is set`);
}
