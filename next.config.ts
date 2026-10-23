import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// tech-stack.md §3 rule 7
const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg", "pg-boss", "pino", "@react-pdf/renderer"],
  // AGENTS.md is owner-maintained; stop `next dev` from writing into it.
  agentRules: false,
  // forbidden() renders src/app/forbidden.tsx with HTTP 403 (task 12, V9).
  experimental: { authInterrupts: true },
  // Static assets skip proxy.ts, which sets nosniff (and the CSP) on
  // everything else; this value needs no configuration, so build time is fine.
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default withNextIntl(nextConfig);
