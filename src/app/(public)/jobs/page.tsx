// Public job board (ats-project-scope.md §5.3): External, published
// requisitions, rendered per request, with keyword search and Location and
// Department filters kept in the URL (a GET form that works without
// JavaScript).
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { JOBS_PAGE_SIZE, boardFilterOptions, listPublicJobs, normalizeBoardQuery } from "@/server/careers";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Careers");
  return { title: t("boardTitle") };
}

export default async function JobBoardPage({ searchParams }: PageProps<"/jobs">) {
  const query = normalizeBoardQuery(await searchParams);
  const t = await getTranslations("Careers");
  const [{ jobs, total }, options] = await Promise.all([listPublicJobs(query), boardFilterOptions()]);
  const filtered = query.q !== "" || query.location !== undefined || query.department !== undefined;
  const pages = Math.max(1, Math.ceil(total / JOBS_PAGE_SIZE));
  const pageLink = (page: number) => {
    const search = new URLSearchParams();
    if (query.q) search.set("q", query.q);
    if (query.location) search.set("location", query.location);
    if (query.department) search.set("department", query.department);
    search.set("page", String(page));
    return `/jobs?${search.toString()}`;
  };
  const field = "w-full rounded border border-neutral-500 bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-neutral-900";

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold">{t("boardTitle")}</h1>
      <form method="get" action="/jobs" role="search" aria-label={t("searchLabel")} className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
        <div className="space-y-1">
          <label htmlFor="jobs-q" className="block text-sm font-medium">
            {t("keywords")}
          </label>
          <input id="jobs-q" name="q" type="search" defaultValue={query.q} maxLength={100} className={field} />
        </div>
        <div className="space-y-1">
          <label htmlFor="jobs-location" className="block text-sm font-medium">
            {t("location")}
          </label>
          <select id="jobs-location" name="location" defaultValue={query.location ?? ""} className={field}>
            <option value="">{t("allLocations")}</option>
            {options.locations.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="jobs-department" className="block text-sm font-medium">
            {t("department")}
          </label>
          <select id="jobs-department" name="department" defaultValue={query.department ?? ""} className={field}>
            <option value="">{t("allDepartments")}</option>
            {options.departments.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="rounded bg-neutral-900 px-5 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900">
          {t("search")}
        </button>
      </form>

      <section aria-labelledby="results-heading" className="space-y-4">
        <h2 id="results-heading" className="text-xl font-semibold">
          {t("results", { count: String(total) })}
        </h2>
        {jobs.length === 0 ? (
          <div className="space-y-2">
            <p>{filtered ? t("noMatches") : t("noJobs")}</p>
            {filtered && (
              <Link href="/jobs" className="underline underline-offset-4">
                {t("clearFilters")}
              </Link>
            )}
          </div>
        ) : (
          <ul className="divide-y rounded border">
            {jobs.map((job) => (
              <li key={job.id} className="p-4" data-testid="job-listing">
                <h3 className="text-lg font-semibold">
                  <Link href={`/jobs/${job.id}`} className="underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">
                    {job.title}
                  </Link>
                </h3>
                <p className="text-neutral-700">
                  {job.department} · {job.location}
                </p>
              </li>
            ))}
          </ul>
        )}
        {pages > 1 && (
          <nav aria-label={t("pagination")} className="flex items-center gap-4">
            {query.page > 1 && (
              <Link href={pageLink(query.page - 1)} className="underline underline-offset-4">
                {t("previous")}
              </Link>
            )}
            <span>{t("pageInfo", { page: String(query.page), pages: String(pages) })}</span>
            {query.page < pages && (
              <Link href={pageLink(query.page + 1)} className="underline underline-offset-4">
                {t("next")}
              </Link>
            )}
          </nav>
        )}
      </section>
    </div>
  );
}
