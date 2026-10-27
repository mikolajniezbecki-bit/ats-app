// Exports (ats-project-scope.md §5.6 Hire export, V10): Admins and
// Recruiters download the hire CSV; everyone else gets the 403 page. Task 41
// adds the report exports here.
import { getTranslations } from "next-intl/server";
import { HireExportForm } from "@/components/exports/hire-export-form";
import { countNewHires } from "@/server/exports/hires";
import { requirePermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";

export default async function ExportsPage() {
  await requirePermission("export.hires", undefined, "/exports");
  const t = await getTranslations("Exports");
  const count = await countNewHires();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <section aria-labelledby="hires-heading" className="max-w-xl space-y-3">
        <h2 id="hires-heading" className="text-xl font-semibold">
          {t("hires.title")}
        </h2>
        <p data-testid="new-hires">{t("hires.newCount", { count })}</p>
        <HireExportForm />
        <p className="text-sm text-neutral-700">{t("hires.note")}</p>
      </section>
    </main>
  );
}
