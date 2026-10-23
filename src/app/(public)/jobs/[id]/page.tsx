// External job page (ats-project-scope.md §5.3): only External requisitions
// approved at least once; anything else is the public 404.
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { JobView } from "@/components/careers/job-view";
import { findExternalJob } from "@/server/careers";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/jobs/[id]">): Promise<Metadata> {
  const job = await findExternalJob((await params).id);
  const t = await getTranslations("Careers");
  if (!job) return { title: t("notFound") };
  return { title: t("pageTitle", { title: job.title }), ...(job.isPublished ? {} : { robots: { index: false, follow: false } }) };
}

export default async function ExternalJobPage({ params }: PageProps<"/jobs/[id]">) {
  const job = await findExternalJob((await params).id);
  if (!job) notFound();
  return <JobView job={job} applyHref={`/apply/${job.id}`} />;
}
