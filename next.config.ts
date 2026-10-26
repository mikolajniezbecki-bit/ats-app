import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// tech-stack.md §3 rule 7
const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg", "pg-boss", "pino", "@react-pdf/renderer"],
  // P4, P5 (task 37 Q10): the offer letter reads its fonts from disk, which
  // standalone tracing can't see; public/ is copied by the Dockerfile.
  outputFileTracingIncludes: { "/**": ["./src/server/pdf/fonts/**"] },
  // AGENTS.md is owner-maintained; stop `next dev` from writing into it.
  agentRules: false,
  experimental: {
    // forbidden() renders src/app/forbidden.tsx with HTTP 403 (task 12, V9).
    authInterrupts: true,
    // Quick Apply (§3 rule 7): two files at the 10 MiB maximum of
    // MAX_UPLOAD_MB plus the form fields, through the server action and the
    // proxy, which would otherwise cut bodies at 1 MB and 10 MB.
    serverActions: { bodySizeLimit: "21mb" },
    proxyClientMaxBodySize: "21mb",
  },
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
