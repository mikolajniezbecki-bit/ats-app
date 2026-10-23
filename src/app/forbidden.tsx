// Rendered with HTTP 403 when a guard calls forbidden() (V9, AU9).
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export default async function Forbidden() {
  const t = await getTranslations("Forbidden");

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <Link href="/dashboard" className="underline">
        {t("home")}
      </Link>
    </main>
  );
}
