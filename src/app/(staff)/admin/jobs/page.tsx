// Background jobs (tech-stack.md J6, M6): counts and the newest jobs per
// queue and state, and the daily-task runs of the last 30 Warsaw days.
// Admin only. Payloads are shown as they are: they hold IDs only (J4).
import { getFormatter, getTranslations } from "next-intl/server";
import { type JobListState, QUEUE_NAMES, countJobsByState, listJobs } from "@/server/adapters/job-queue";
import { listRecentJobRuns } from "@/server/jobs/runs";
import { requirePermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";

const STATES: JobListState[] = ["queued", "active", "failed"];

export default async function JobsPage() {
  await requirePermission("jobs.view", undefined, "/admin/jobs");
  const t = await getTranslations("AdminJobs");
  const format = await getFormatter();
  const time = (value: Date | null) => (value ? `${format.dateTime(value, { dateStyle: "short", timeStyle: "medium", timeZone: "UTC" })} UTC` : "—");
  const counts = await countJobsByState();
  const lists = await Promise.all(
    QUEUE_NAMES.flatMap((queue) => STATES.map(async (state) => ({ queue, state, jobs: await listJobs(queue, state) }))),
  );
  const runs = await listRecentJobRuns();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>

      <section aria-labelledby="queues-heading" className="space-y-2">
        <h2 id="queues-heading" className="text-xl font-semibold">
          {t("queues")}
        </h2>
        <table className="text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-1 pr-6">{t("columns.queue")}</th>
              <th className="py-1 pr-6">{t("columns.queued")}</th>
              <th className="py-1 pr-6">{t("columns.active")}</th>
              <th className="py-1 pr-6">{t("columns.failed")}</th>
            </tr>
          </thead>
          <tbody>
            {counts.map((row) => (
              <tr key={row.queue} className="border-b" data-testid={`queue-${row.queue}`}>
                <td className="py-1 pr-6 font-mono">{row.queue}</td>
                <td className="py-1 pr-6">{row.queued}</td>
                <td className="py-1 pr-6">{row.active}</td>
                <td className="py-1 pr-6">{row.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {lists
          .filter((list) => list.jobs.length > 0)
          .map((list) => (
            <details key={`${list.queue}-${list.state}`} className="rounded border p-2">
              <summary className="cursor-pointer text-sm font-medium">
                {t("jobsIn", { queue: list.queue, state: t(`states.${list.state}`) })} ({list.jobs.length})
              </summary>
              <div className="overflow-x-auto">
                <table className="mt-2 w-full text-left text-xs">
                  <thead>
                    <tr className="border-b">
                      <th className="py-1 pr-4">{t("columns.id")}</th>
                      <th className="py-1 pr-4">{t("columns.state")}</th>
                      <th className="py-1 pr-4">{t("columns.created")}</th>
                      <th className="py-1 pr-4">{t("columns.start")}</th>
                      <th className="py-1 pr-4">{t("columns.retries")}</th>
                      <th className="py-1 pr-4">{t("columns.error")}</th>
                      <th className="py-1">{t("columns.data")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.jobs.map((job) => (
                      <tr key={job.id} className="border-b align-top">
                        <td className="py-1 pr-4 font-mono">{job.id}</td>
                        <td className="py-1 pr-4">{job.state}</td>
                        <td className="py-1 pr-4">{time(job.createdOn)}</td>
                        <td className="py-1 pr-4">{time(job.startAfter)}</td>
                        <td className="py-1 pr-4">{job.retryCount}</td>
                        <td className="py-1 pr-4 break-all">{job.error ?? "—"}</td>
                        <td className="py-1 font-mono break-all">{JSON.stringify(job.data)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
      </section>

      <section aria-labelledby="runs-heading" className="space-y-2">
        <h2 id="runs-heading" className="text-xl font-semibold">
          {t("runs")}
        </h2>
        {runs.length === 0 ? (
          <p className="text-sm">{t("noRuns")}</p>
        ) : (
          <table className="text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-1 pr-6">{t("runColumns.job")}</th>
                <th className="py-1 pr-6">{t("runColumns.runDate")}</th>
                <th className="py-1 pr-6">{t("runColumns.started")}</th>
                <th className="py-1 pr-6">{t("runColumns.finished")}</th>
                <th className="py-1 pr-6">{t("runColumns.duration")}</th>
                <th className="py-1 pr-6">{t("runColumns.status")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b">
                  <td className="py-1 pr-6 font-mono">{run.jobName}</td>
                  <td className="py-1 pr-6">{run.runDate}</td>
                  <td className="py-1 pr-6">{time(run.startedAt)}</td>
                  <td className="py-1 pr-6">{time(run.finishedAt)}</td>
                  <td className="py-1 pr-6">
                    {run.finishedAt ? t("seconds", { value: ((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000).toFixed(1) }) : "—"}
                  </td>
                  <td className="py-1 pr-6">{run.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
