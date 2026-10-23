// The public 404 for job pages (§5.3): unknown, never-approved, or under the
// wrong route for its posting type.
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export default async function JobNotFound() {
  const t = await getTranslations("Careers");
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("notFound")}</h1>
      <Link href="/jobs" className="underline underline-offset-4">
        {t("allJobs")}
      </Link>
    </div>
  );
}
