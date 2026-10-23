// Admin template list (ats-project-scope.md §5.1): by type, with trigger
// status for email templates; inactive ones on request.
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { TEMPLATE_TYPES } from "@/server/db/schema";
import { requirePermission } from "@/server/policy/guards";
import { listTemplates } from "@/server/templates";

export const dynamic = "force-dynamic";

export default async function TemplatesPage({ searchParams }: PageProps<"/admin/templates">) {
  await requirePermission("templates.manage", undefined, "/admin/templates");
  const includeInactive = (await searchParams).inactive === "1";
  const t = await getTranslations("AdminTemplates");
  const statuses = await getTranslations("Statuses");
  const rows = await listTemplates({ includeInactive });

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <div className="flex flex-wrap items-center gap-4">
        <Link href="/admin/templates/new" className="rounded bg-black px-4 py-2 text-white">
          {t("add")}
        </Link>
        <Link href={includeInactive ? "/admin/templates" : "/admin/templates?inactive=1"} className="text-sm underline">
          {includeInactive ? t("hideInactive") : t("showInactive")}
        </Link>
      </div>
      {TEMPLATE_TYPES.map((type) => {
        const ofType = rows.filter((row) => row.type === type);
        return (
          <section key={type} aria-labelledby={`section-${type}`} className="space-y-2">
            <h2 id={`section-${type}`} className="text-xl font-semibold">
              {t(`types.${type}`)}
            </h2>
            {ofType.length === 0 ? (
              <p className="text-sm">{t("empty")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="py-1 pr-4">{t("columns.name")}</th>
                      {type === "EMAIL" && <th className="py-1 pr-4">{t("columns.trigger")}</th>}
                      <th className="py-1 pr-4">{t("columns.status")}</th>
                      <th className="py-1">{t("columns.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ofType.map((row) => (
                      <tr key={row.id} className="border-b" data-testid={`template-${row.name}`}>
                        <td className="py-2 pr-4">{row.name}</td>
                        {type === "EMAIL" && <td className="py-2 pr-4">{row.triggerStatus ? statuses(row.triggerStatus) : t("bulk")}</td>}
                        <td className="py-2 pr-4">{row.isActive ? t("active") : t("inactive")}</td>
                        <td className="py-2">
                          <Link href={`/admin/templates/${row.id}`} className="underline" aria-label={`${t("edit")} ${row.name}`}>
                            {t("edit")}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}
