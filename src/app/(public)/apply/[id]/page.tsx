// Quick Apply for an External posting (ats-project-scope.md §5.3):
// `source = CAREER_SITE`. Resolved like /jobs/{id}; anything else is 404.
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { ApplyPage } from "@/components/careers/apply-page";
import { findExternalJob } from "@/server/careers";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/apply/[id]">): Promise<Metadata> {
  const job = await findExternalJob((await params).id);
  const t = await getTranslations("Apply");
  return { title: job ? t("pageTitle", { title: job.title }) : t("notFound"), robots: { index: false, follow: false } };
}

export default async function ApplyExternalPage({ params }: PageProps<"/apply/[id]">) {
  const job = await findExternalJob((await params).id);
  if (!job) notFound();
  return <ApplyPage job={job} route={{ kind: "external", key: job.id }} />;
}
