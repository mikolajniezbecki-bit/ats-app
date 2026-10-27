// The KPI dashboard (ats-project-scope.md §5.9, L10): Recruiters and Admins
// (reports.view, task 41 Q1); everyone else gets the 403 page. Rendered at
// request time (§3 rule 3); every number comes from the reporting service.
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OPEN_STATUSES } from "@/server/domain/pipeline";
import { formatDays } from "@/server/domain/reporting";
import { requirePermission } from "@/server/policy/guards";
import { getDashboard } from "@/server/reporting";

export const dynamic = "force-dynamic";

function Card({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} data-testid={testId} className="space-y-2 rounded border p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default async function ReportsPage() {
  const user = await requirePermission("reports.view", undefined, "/reports");
  const t = await getTranslations("Reports");
  const statuses = await getTranslations("Statuses");
  const states = await getTranslations("Requisitions.states");
  const dashboard = await getDashboard(user);
  if (!dashboard) notFound();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div className="grid max-w-5xl gap-4 md:grid-cols-2">
        <Card title={t("open.title")} testId="kpi-open">
          <p className="text-3xl font-semibold">{dashboard.openRequisitions}</p>
        </Card>
        <Card title={t("active.title")} testId="kpi-active">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
            {OPEN_STATUSES.map((status) => (
              <div key={status} className="contents">
                <dt>{statuses(status)}</dt>
                <dd className="font-semibold">{dashboard.activeByStatus[status]}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title={t("timeToFill.title")} testId="kpi-time-to-fill">
          <p className="text-3xl font-semibold">{formatDays(dashboard.timeToFill.average)}</p>
          <p className="text-sm">{t("timeToFill.basis", { count: dashboard.timeToFill.count })}</p>
        </Card>
        <Card title={t("timeToHire.title")} testId="kpi-time-to-hire">
          <p className="text-3xl font-semibold">{formatDays(dashboard.timeToHire.average)}</p>
          <p className="text-sm">{t("timeToHire.basis", { count: dashboard.timeToHire.count })}</p>
        </Card>
      </div>
      <Card title={t("age.title")} testId="kpi-age">
        {dashboard.ages.length === 0 ? (
          <p className="text-sm">—</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-left text-sm">
              <thead>
                <tr>
                  <th className="py-1 pr-4">{t("age.number")}</th>
                  <th className="py-1 pr-4">{t("age.requisition")}</th>
                  <th className="py-1 pr-4">{t("age.state")}</th>
                  <th className="py-1 pr-4">{t("age.days")}</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.ages.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="py-2 pr-4">{row.reqNumber}</td>
                    <td className="py-2 pr-4">
                      <Link href={`/requisitions/${row.id}`} className="underline">
                        {row.title}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">{states(row.state)}</td>
                    <td className="py-2 pr-4">{formatDays(row.age)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </main>
  );
}
