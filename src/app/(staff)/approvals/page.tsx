// "My approvals" (ats-project-scope.md A1, A3): requisitions in
// PENDING_APPROVAL whose approver is the current user. Offers are added in
// task 36.
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { listMyRequisitionApprovals } from "@/server/approvals";
import { requirePermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const user = await requirePermission("approval.decide", undefined, "/approvals");
  const t = await getTranslations("Approvals");
  const rows = await listMyRequisitionApprovals(user);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
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
                  <td className="py-2 pr-4">{row.submittedAt ? `${row.submittedAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
