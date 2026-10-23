// Private job page (ats-project-scope.md §5.2 Postings, §5.3): reachable only
// through its slug, never indexed; proxy.ts also sends X-Robots-Tag and
// Referrer-Policy: no-referrer for these paths.
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { JobView } from "@/components/careers/job-view";
import { findPrivateJob } from "@/server/careers";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/jobs/p/[slug]">): Promise<Metadata> {
  const job = await findPrivateJob((await params).slug);
  const t = await getTranslations("Careers");
  return {
    title: job ? t("pageTitle", { title: job.title }) : t("notFound"),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function PrivateJobPage({ params }: PageProps<"/jobs/p/[slug]">) {
  const { slug } = await params;
  const job = await findPrivateJob(slug);
  if (!job) notFound();
  return <JobView job={job} applyHref={`/apply/p/${slug}`} />;
}
