// "My interviews" (ats-project-scope.md V5, I6, I7, I9; task 34 Q6): every
// role's interviews as a current participant, upcoming first, with the state
// of their own scorecard and a link to the scorecard page.
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { listMyInterviews } from "@/server/interviews";
import { requirePermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";

export default async function MyInterviewsPage() {
  const user = await requirePermission("staff.area", undefined, "/interviews");
  const t = await getTranslations("MyInterviews");
  const i = await getTranslations("Interviews");
  const rows = await listMyInterviews(user);

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
                {(["when", "candidate", "job", "status", "scorecard"] as const).map((column) => (
                  <th key={column} className="py-1 pr-4">
                    {t(`columns.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b" data-testid={`my-interview-${row.id}`}>
                  <td className="py-2 pr-4">
                    <LocalTime value={row.startsAtUtc.toISOString()} />
                  </td>
                  <td className="py-2 pr-4">{row.candidate ?? t("anonymized")}</td>
                  <td className="py-2 pr-4">{row.jobTitle}</td>
                  <td className="py-2 pr-4">{i(`statuses.${row.status}`)}</td>
                  <td className="py-2 pr-4">
                    <Link href={`/interviews/${row.id}/scorecard`} className="underline">
                      {t("open")}: {t(`scorecardStates.${row.scorecard}`)}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
