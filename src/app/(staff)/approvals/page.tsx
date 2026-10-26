// Approvals (ats-project-scope.md A1, A3, A4, A5). "My approvals": the
// requisitions in PENDING_APPROVAL whose approver is the current user.
// "All pending approvals" (`?view=all`, `approval.reassign`): every pending
// requisition with its approver, so Recruiters and Admins can find what to
// reassign, also before a deactivation. Pending offers are listed below the
// requisitions in both views (task 36) and link to the application page,
// where the approver decides.
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { listAllPendingRequisitionApprovals, listMyRequisitionApprovals } from "@/server/approvals";
import { listAllPendingOfferApprovals, listMyOfferApprovals } from "@/server/approvals/offers";
import { warsawRunDate } from "@/server/domain/daily-tasks";
import { requireUser } from "@/server/policy/guards";
import { can } from "@/server/policy/permissions";

export const dynamic = "force-dynamic";

const utc = (date: Date | null) => (date ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : "");

/** Europe/Warsaw calendar days from `since` to today, as the reminders count them (A6). */
function daysWaiting(since: Date | null, today: string): number | null {
  if (!since) return null;
  return Math.round((Date.parse(today) - Date.parse(warsawRunDate(since))) / 86_400_000);
}

type OfferRow = Awaited<ReturnType<typeof listAllPendingOfferApprovals>>[number];

/** The pending offers table (task 36): number, job title, candidate, people, time and days waiting. */
async function OfferTable({ rows, showApprover, today }: { rows: OfferRow[]; showApprover: boolean; today: string }) {
  const t = await getTranslations("Approvals");
  return (
    <section aria-labelledby="offer-approvals-heading" className="space-y-2">
      <h2 id="offer-approvals-heading" className="text-xl font-semibold">
        {t("offers.title")}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm">{t("offers.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-1 pr-4">{t("columns.reqNumber")}</th>
                <th className="py-1 pr-4">{t("offers.jobTitle")}</th>
                <th className="py-1 pr-4">{t("offers.candidate")}</th>
                {showApprover && <th className="py-1 pr-4">{t("all.approver")}</th>}
                <th className="py-1 pr-4">{t("columns.submitter")}</th>
                <th className="py-1 pr-4">{t("columns.submittedAt")}</th>
                <th className="py-1 pr-4">{t("all.daysWaiting")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b" data-testid={`offer-approval-${row.id}`}>
                  <td className="py-2 pr-4">
                    <Link href={`/applications/${row.applicationId}`} className="underline">
                      {row.reqNumber}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">{row.jobTitle}</td>
                  <td className="py-2 pr-4">{row.candidate}</td>
                  {showApprover && <td className="py-2 pr-4">{row.approver && (row.approverActive ? row.approver : t("all.inactive", { name: row.approver }))}</td>}
                  <td className="py-2 pr-4">{row.submitter}</td>
                  <td className="py-2 pr-4">{utc(row.submittedAt)}</td>
                  <td className="py-2 pr-4">{daysWaiting(row.submittedAt, today)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function ApprovalsPage({ searchParams }: PageProps<"/approvals">) {
  const { view } = await searchParams;
  const user = await requireUser("/approvals");
  const canDecide = can(user, "approval.decide");
  const canReassign = can(user, "approval.reassign");
  const all = view === "all";
  if (all ? !canReassign : !canDecide) forbidden();
  const t = await getTranslations("Approvals");

  const tabs = canDecide && canReassign && (
    <nav aria-label={t("title")} className="flex gap-4 text-sm">
      {(["mine", "all"] as const).map((tab) => (
        <Link
          key={tab}
          href={tab === "all" ? "/approvals?view=all" : "/approvals"}
          aria-current={(tab === "all") === all ? "page" : undefined}
          className={(tab === "all") === all ? "font-semibold underline" : "underline"}
        >
          {t(`tabs.${tab}`)}
        </Link>
      ))}
    </nav>
  );

  if (all) {
    const rows = await listAllPendingRequisitionApprovals();
    const offerRows = await listAllPendingOfferApprovals();
    const today = warsawRunDate(new Date());
    return (
      <main className="flex flex-1 flex-col gap-6 p-8">
        {tabs}
        <h1 className="text-2xl font-semibold">{t("all.title")}</h1>
        <p className="text-sm text-neutral-700">{t("all.description")}</p>
        {rows.length === 0 ? (
          <p>{t("all.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-1 pr-4">{t("columns.reqNumber")}</th>
                  <th className="py-1 pr-4">{t("columns.title")}</th>
                  <th className="py-1 pr-4">{t("all.approver")}</th>
                  <th className="py-1 pr-4">{t("columns.submitter")}</th>
                  <th className="py-1 pr-4">{t("columns.submittedAt")}</th>
                  <th className="py-1 pr-4">{t("all.daysWaiting")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b" data-testid={`pending-${row.reqNumber}`}>
                    <td className="py-2 pr-4">
                      <Link href={`/requisitions/${row.id}`} className="underline">
                        {row.reqNumber}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      {row.title}
                      {row.reApproval && <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">{t("reApproval")}</span>}
                    </td>
                    <td className="py-2 pr-4">{row.approver && (row.approverActive ? row.approver : t("all.inactive", { name: row.approver }))}</td>
                    <td className="py-2 pr-4">{row.submitter}</td>
                    <td className="py-2 pr-4">{utc(row.submittedAt)}</td>
                    <td className="py-2 pr-4">{daysWaiting(row.submittedAt, today)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <OfferTable rows={offerRows} showApprover today={today} />
      </main>
    );
  }

  const rows = await listMyRequisitionApprovals(user);
  const myOffers = await listMyOfferApprovals(user);
  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      {tabs}
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-neutral-700">{t("description")}</p>
      {rows.length === 0 ? (
        <p>{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                {(["reqNumber", "title", "department", "submitter", "submittedAt"] as const).map((column) => (
                  <th key={column} className="py-1 pr-4">
                    {t(`columns.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b" data-testid={`approval-${row.reqNumber}`}>
                  <td className="py-2 pr-4">
                    <Link href={`/requisitions/${row.id}`} className="underline">
                      {row.reqNumber}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">
                    {row.title}
                    {row.reApproval && (
                      <>
                        <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">{t("reApproval")}</span>
                        <ul className="mt-1 list-disc pl-5 text-xs">
                          {row.changes.map((change) => (
                            <li key={change.field}>{t("change", { field: t(`l2Fields.${change.field}`), from: change.from, to: change.to })}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </td>
                  <td className="py-2 pr-4">{row.department}</td>
                  <td className="py-2 pr-4">{row.submitter}</td>
                  <td className="py-2 pr-4">{utc(row.submittedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <OfferTable rows={myOffers} showApprover={false} today={warsawRunDate(new Date())} />
    </main>
  );
}
