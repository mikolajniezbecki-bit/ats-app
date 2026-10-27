// Exports (ats-project-scope.md §5.6 Hire export, §5.9, V10): Admins and
// Recruiters download the hire CSV and the requisition and pipeline CSVs;
// everyone else gets the 403 page.
import { getTranslations } from "next-intl/server";
import { HireExportForm } from "@/components/exports/hire-export-form";
import { countNewHires } from "@/server/exports/hires";
import { requirePermission } from "@/server/policy/guards";
import { can } from "@/server/policy/permissions";

export const dynamic = "force-dynamic";

export default async function ExportsPage() {
  const user = await requirePermission("export.hires", undefined, "/exports");
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
      {can(user, "export.reports") && (
        <section aria-labelledby="reports-heading" className="max-w-xl space-y-3">
          <h2 id="reports-heading" className="text-xl font-semibold">
            {t("reports.title")}
          </h2>
          {/* GET downloads (task 41 Q4): they change nothing, so a plain link is safe. */}
          <ul className="flex flex-wrap gap-3">
            <li>
              <a href="/api/exports/requisitions" download className="inline-block rounded border px-4 py-2">
                {t("reports.requisitions")}
              </a>
            </li>
            <li>
              <a href="/api/exports/pipeline" download className="inline-block rounded border px-4 py-2">
                {t("reports.pipeline")}
              </a>
            </li>
          </ul>
          <p className="text-sm text-neutral-700">{t("reports.note")}</p>
        </section>
      )}
    </main>
  );
}
