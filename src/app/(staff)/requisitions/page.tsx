// Requisition list (ats-project-scope.md §5.2, V2, V3a): what the caller may
// see, newest number first, 50 per page, with a state filter.
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { REQUISITION_STATES } from "@/server/db/schema";
import { requirePermission } from "@/server/policy/guards";
import { can } from "@/server/policy/permissions";
import { listQuerySchema, listRequisitions } from "@/server/requisitions";

export const dynamic = "force-dynamic";

export default async function RequisitionsPage({ searchParams }: PageProps<"/requisitions">) {
  const user = await requirePermission("requisition.read", undefined, "/requisitions");
  const params = await searchParams;
  const parsed = listQuerySchema.safeParse({
    state: typeof params.state === "string" && params.state !== "" ? params.state : undefined,
    page: typeof params.page === "string" ? params.page : undefined,
  });
  const query = parsed.success ? parsed.data : { page: 1 };
  const t = await getTranslations("Requisitions");
  const { rows, total, page, pageSize } = await listRequisitions(user, query);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const pageLink = (target: number) => {
    const search = new URLSearchParams({ ...(query.state ? { state: query.state } : {}), page: String(target) });
    return `/requisitions?${search.toString()}`;
  };

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-neutral-700">{t("description")}</p>
      <div className="flex flex-wrap items-end gap-4">
        {can(user, "requisition.create") && (
          <Link href="/requisitions/new" className="rounded bg-black px-4 py-2 text-white">
            {t("new")}
          </Link>
        )}
        <form method="get" className="flex items-end gap-2">
          <div className="space-y-1">
            <label htmlFor="state-filter" className="block text-sm font-medium">
              {t("stateFilter")}
            </label>
            <select id="state-filter" name="state" defaultValue={query.state ?? ""} className="rounded border px-3 py-2">
              <option value="">{t("allStates")}</option>
              {REQUISITION_STATES.map((state) => (
                <option key={state} value={state}>
                  {t(`states.${state}`)}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="rounded border px-4 py-2">
            {t("filter")}
          </button>
        </form>
      </div>
      {rows.length === 0 ? (
        <p>{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                {(["reqNumber", "title", "state", "department", "location", "hiringManager", "recruiter", "updatedAt"] as const).map((column) => (
                  <th key={column} className="py-1 pr-4">
                    {t(`columns.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b" data-testid={`requisition-${row.reqNumber}`}>
                  <td className="py-2 pr-4">
                    <Link href={`/requisitions/${row.id}`} className="underline">
                      {row.reqNumber}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">{row.title}</td>
                  <td className="py-2 pr-4">{t(`states.${row.state}`)}</td>
                  <td className="py-2 pr-4">{row.department}</td>
                  <td className="py-2 pr-4">{row.location}</td>
                  <td className="py-2 pr-4">{row.hiringManager}</td>
                  <td className="py-2 pr-4">{row.recruiter}</td>
                  <td className="py-2 pr-4">
                    <time dateTime={row.updatedAt.toISOString()}>{row.updatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label={t("pageInfo", { page: String(page), pages: String(pages) })} className="flex items-center gap-4 text-sm">
        {page > 1 && (
          <Link href={pageLink(page - 1)} className="underline">
            {t("previous")}
          </Link>
        )}
        <span>{t("pageInfo", { page: String(page), pages: String(pages) })}</span>
        {page < pages && (
          <Link href={pageLink(page + 1)} className="underline">
            {t("next")}
          </Link>
        )}
      </nav>
    </main>
  );
}
