// /sitemap.xml (ats-project-scope.md §5.2 Postings): the board and every
// listed External job as absolute URLs; never a private posting.
import type { MetadataRoute } from "next";
import { sitemapJobIds } from "@/server/careers";
import { getConfig } from "@/server/config";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = getConfig().auth.url.replace(/\/$/, "");
  const ids = await sitemapJobIds();
  return [{ url: `${base}/jobs` }, ...ids.map((id) => ({ url: `${base}/jobs/${id}` }))];
}
