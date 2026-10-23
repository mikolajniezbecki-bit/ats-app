// The same confirmation for every outcome (ats-project-scope.md §5.3): it
// never reveals the score or a disqualification. Reached by a redirect, so
// a refresh doesn't resubmit.
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Apply");
  return { title: t("thanksTitle"), robots: { index: false, follow: false } };
}

export default async function ThanksPage() {
  const t = await getTranslations("Apply");
  const careers = await getTranslations("Careers");
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold">{t("thanksTitle")}</h1>
      <p>{t("thanks")}</p>
      <Link href="/jobs" className="underline underline-offset-4">
        {careers("allJobs")}
      </Link>
    </div>
  );
}
