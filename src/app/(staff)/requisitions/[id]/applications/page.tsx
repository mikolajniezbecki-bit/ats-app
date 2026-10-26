// The applications of one requisition (ats-project-scope.md §5.4 Recruiter
// workbench, E5, TO-01): 50 per page, newest first, with a status filter.
// Applications from the same email address sit together under a group row
// and link to the candidate's applications elsewhere; they stay separate
// records. Admins, Recruiters and Hiring Managers in V3a (read-only, no bulk
// actions); Interviewers never see requisition pages (403); 404 outside the
// caller's scope (V9).
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BulkBar, BulkProvider, BulkRowCheckbox, BulkSelectAll } from "@/components/applications/bulk-actions";
import { LocalTime } from "@/components/local-time";
import { type ApplicationStatus, listRequisitionApplications } from "@/server/applications";
import { APPLICATION_STATUSES } from "@/server/db/schema";
import { listBulkTemplates } from "@/server/email/bulk";
import { requirePermission } from "@/server/policy/guards";
import { can } from "@/server/policy/permissions";

export const dynamic = "force-dynamic";

export default async function RequisitionApplicationsPage({ params, searchParams }: PageProps<"/requisitions/[id]/applications">) {
  const { id } = await params;
  const user = await requirePermission("requisition.read", undefined, `/requisitions/${encodeURIComponent(id)}/applications`);
  const query = await searchParams;
  const status = APPLICATION_STATUSES.find((value) => value === query.status);
  const page = Number.parseInt(String(query.page ?? "1"), 10) || 1;
  const list = await listRequisitionApplications(user, id, { status, page });
  if (!list) notFound();
  const { requisition } = list;
  const t = await getTranslations("Applications");
  const statuses = await getTranslations("Statuses");
  const base = `/requisitions/${requisition.id}/applications`;
  const href = (value: ApplicationStatus | undefined, pageNumber = 1) => {
    const search = new URLSearchParams();
    if (value) search.set("status", value);
    if (pageNumber > 1) search.set("page", String(pageNumber));
    const text = search.toString();
    return text ? `${base}?${text}` : base;
  };
  const all = Object.values(list.counts).reduce((sum, n) => sum + n, 0);
  // Bulk actions (§5.4): only for users who may change status.
  const bulk = can(user, "application.changeStatus");
  const nameOf = (row: (typeof list.rows)[number]) => (row.anonymized ? t("anonymized") : `${row.firstName} ${row.lastName}`);
  const bulkTemplates = bulk && can(user, "application.bulkEmail") ? await listBulkTemplates() : [];
  const statusLabels = Object.fromEntries(APPLICATION_STATUSES.map((value) => [value, statuses(value)]));

  const content = (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <Link href={`/requisitions/${requisition.id}`} className="text-sm underline">
        {t("backToRequisition")}
      </Link>
      <h1 className="text-2xl font-semibold">{t("listTitle", { reqNumber: requisition.reqNumber, title: requisition.title })}</h1>
      <nav aria-label={t("filterLabel")} className="flex flex-wrap gap-3 text-sm">
        <span>{t("filterLabel")}:</span>
        <Link href={href(undefined)} aria-current={status === undefined ? "page" : undefined} className="underline aria-[current=page]:font-semibold aria-[current=page]:no-underline">
          {t("all", { count: all })}
        </Link>
        {APPLICATION_STATUSES.map((value) => (
          <Link
            key={value}
            href={href(value)}
            aria-current={value === status ? "page" : undefined}
            className="underline aria-[current=page]:font-semibold aria-[current=page]:no-underline"
          >
            {t("statusCount", { status: statuses(value), count: list.counts[value] })}
          </Link>
        ))}
      </nav>
      {bulk && list.rows.length > 0 && <BulkBar templates={bulkTemplates} statusLabels={statusLabels} />}
      {list.rows.length === 0 ? (
        <p className="text-sm">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                {bulk && (
                  <th className="py-1 pr-2">
                    <BulkSelectAll />
                  </th>
                )}
                <th className="py-1 pr-4">{t("columns.name")}</th>
                <th className="py-1 pr-4">{t("columns.email")}</th>
                <th className="py-1 pr-4">{t("columns.status")}</th>
                <th className="py-1 pr-4">{t("columns.score")}</th>
                <th className="py-1 pr-4">{t("columns.source")}</th>
                <th className="py-1 pr-4">{t("columns.applied")}</th>
                <th className="py-1">{t("columns.open")}</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.flatMap((row) => {
                const name = nameOf(row);
                const cells = (
                  <tr key={row.id} className={`border-b align-top ${row.groupSize > 1 ? "bg-gray-50" : ""}`} data-testid={`application-row-${row.id}`}>
                    {bulk && (
                      <td className="py-2 pr-2">
                        <BulkRowCheckbox id={row.id} name={name} />
                      </td>
                    )}
                    <td className="py-2 pr-4">
                      <span className={row.groupSize > 1 ? "pl-4" : undefined}>{name}</span>
                      {row.hasFailedEmail && (
                        <span role="img" aria-label={t("failedEmailIcon")} title={t("failedEmailIcon")} className="ml-2 text-red-700" data-testid="failed-email-icon">
                          ⚠
                        </span>
                      )}
                      {row.alsoAppliedTo.length > 0 && (
                        <p className="mt-1 text-xs">
                          {t("alsoAppliedTo")}{" "}
                          {row.alsoAppliedTo.map((other, index) => (
                            <span key={other.id}>
                              {index > 0 && ", "}
                              <Link href={`/applications/${other.id}`} className="underline">
                                {t("related", { reqNumber: other.reqNumber, status: statuses(other.status) })}
                              </Link>
                            </span>
                          ))}
                        </p>
                      )}
                    </td>
                    <td className="py-2 pr-4">{row.anonymized ? t("anonymized") : row.email}</td>
                    <td className="py-2 pr-4">{statuses(row.status)}</td>
                    <td className="py-2 pr-4">
                      {row.prescreenScore}
                      {row.isDisqualified && <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-900">{t("disqualified")}</span>}
                    </td>
                    <td className="py-2 pr-4">{t(`sources.${row.source}`)}</td>
                    <td className="py-2 pr-4">
                      <LocalTime value={row.appliedAt.toISOString()} dateOnly />
                    </td>
                    <td className="py-2">
                      <Link href={`/applications/${row.id}`} className="underline">
                        {t("open")}
                      </Link>
                    </td>
                  </tr>
                );
                if (!row.groupStart) return [cells];
                return [
                  <tr key={`group-${row.id}`} className="border-b bg-gray-100" data-testid="application-group">
                    <th scope="rowgroup" colSpan={bulk ? 8 : 7} className="py-1 text-left text-xs font-medium">
                      {t("group", { count: row.groupSize })}
                    </th>
                  </tr>,
                  cells,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label={t("pageLabel")} className="flex items-center gap-4 text-sm">
        {list.page > 1 && (
          <Link href={href(status, list.page - 1)} className="underline">
            {t("previous")}
          </Link>
        )}
        <span>{t("pageOf", { page: list.page, pages: list.pages })}</span>
        {list.page < list.pages && (
          <Link href={href(status, list.page + 1)} className="underline">
            {t("next")}
          </Link>
        )}
      </nav>
    </main>
  );
  return bulk ? <BulkProvider items={list.rows.map((row) => ({ id: row.id, version: row.version, name: nameOf(row) }))}>{content}</BulkProvider> : content;
}
