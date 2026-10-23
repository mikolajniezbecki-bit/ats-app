import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Only adapters talk to external SDKs (tech-stack.md §3 rule 4): pg-boss
  // behind JobQueue (J4), the Azure SDK behind StorageService (§8).
  {
    ignores: ["src/server/adapters/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "pg-boss", message: "Use the JobQueue adapter in src/server/adapters/job-queue (J4)." },
            { name: "nodemailer", message: "Queue emails with queueEmail() in src/server/email; only src/server/adapters/email talks to Nodemailer." },
          ],
          patterns: [
            { group: ["pg-boss/*"], message: "Use the JobQueue adapter in src/server/adapters/job-queue (J4)." },
            { group: ["nodemailer/*"], message: "Only src/server/adapters/email talks to Nodemailer (§3 rule 4)." },
            // @azure/storage-blob and @azure/identity: use StorageService (§8).
            { group: ["@azure/*"], message: "Use the StorageService adapter in src/server/adapters/storage (§3 rule 4)." },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Test and coverage output:
    "coverage/**",
    "test-results/**",
    "playwright-report/**",
    "blob-report/**",
    // Bundled db:migrate entry point (pnpm db:build):
    "dist/**",
  ]),
]);

export default eslintConfig;
