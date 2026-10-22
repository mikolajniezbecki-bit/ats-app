import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Only adapters talk to pg-boss; domain code uses the JobQueue interface
  // (tech-stack.md §3 rule 4, J4).
  {
    ignores: ["src/server/adapters/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "pg-boss", message: "Use the JobQueue adapter in src/server/adapters/job-queue (J4)." }],
          patterns: [{ group: ["pg-boss/*"], message: "Use the JobQueue adapter in src/server/adapters/job-queue (J4)." }],
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
