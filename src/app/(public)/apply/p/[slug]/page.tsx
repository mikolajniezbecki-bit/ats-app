// Quick Apply for a Private posting (ats-project-scope.md §5.3):
// `source = PRIVATE_LINK`. Only through the slug, never by ID.
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { ApplyPage } from "@/components/careers/apply-page";
import { findPrivateJob } from "@/server/careers";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/apply/p/[slug]">): Promise<Metadata> {
  const job = await findPrivateJob((await params).slug);
  const t = await getTranslations("Apply");
  return { title: job ? t("pageTitle", { title: job.title }) : t("notFound"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

export default async function ApplyPrivatePage({ params }: PageProps<"/apply/p/[slug]">) {
  const { slug } = await params;
  const job = await findPrivateJob(slug);
  if (!job) notFound();
  return <ApplyPage job={job} route={{ kind: "private", key: slug }} />;
}
