// /robots.txt: the job board may be crawled; the apply form and every staff
// path may not. Private postings carry noindex on their own pages.
import type { MetadataRoute } from "next";
import { getConfig } from "@/server/config";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = getConfig().auth.url.replace(/\/$/, "");
  return {
    rules: {
      userAgent: "*",
      allow: ["/jobs"],
      disallow: ["/apply/", "/jobs/p/", "/api/", "/admin", "/dashboard", "/requisitions", "/approvals", "/files", "/sign-in"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
