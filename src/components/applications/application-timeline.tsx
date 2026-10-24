// The application timeline (ats-project-scope.md §5.4, E4, E5, RT4): one
// list, oldest first, built by the read model. Email bodies open in a
// sandboxed iframe that can run nothing and fetch nothing remote, as in the
// Outbox (tech-stack.md §9).
import { getTranslations } from "next-intl/server";
import { LocalTime } from "@/components/local-time";
import type { TimelineEntry } from "@/server/applications";

export async function ApplicationTimeline({ entries }: { entries: TimelineEntry[] }) {
  const t = await getTranslations("Applications.timeline");
  const statuses = await getTranslations("Statuses");
  const emailStatuses = await getTranslations("EmailStatuses");
  const reasons = await getTranslations("Applications.reasons");
  const time = (value: Date) => <LocalTime value={value.toISOString()} />;

  return (
    <ol className="space-y-3" data-testid="timeline">
      {entries.map((entry) => (
        <li key={`${entry.kind}-${entry.id}`} data-testid={`timeline-${entry.kind}`} className="rounded border p-3 text-sm">
          <div className="text-xs text-gray-700">
            {entry.kind === "email" && entry.status === "QUEUED" ? t.rich("scheduledFor", { time: () => time(entry.at) }) : time(entry.at)}
          </div>
          {entry.kind === "history" && (
            <div className="space-y-1">
              <p className="font-medium">
                {entry.created ? t("applied") : t("change", { from: statuses(entry.fromStatus!), to: statuses(entry.toStatus) })}
                {entry.created && entry.toStatus !== "APPLIED" ? ` → ${statuses(entry.toStatus)}` : ""}{" "}
                <span className="font-normal">{t("by", { name: entry.changedBy ?? t("system") })}</span>
                {entry.isReopen && <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-900">{t("reopened")}</span>}
              </p>
              {entry.reasonCode && <p>{t("reason", { reason: reasons(entry.reasonCode) })}</p>}
              {entry.removed ? (
                <p>
                  <em>{t("removed")}</em>
                </p>
              ) : (
                entry.comment && <p className="whitespace-pre-wrap">{entry.comment}</p>
              )}
            </div>
          )}
          {entry.kind === "email" && (
            <div className="space-y-1">
              <p className="font-medium">
                {t("email")}: {entry.removed ? <em>{t("removed")}</em> : entry.subject}{" "}
                <span className="font-normal">
                  ({t(`audience.${entry.audience}`)}, {emailStatuses(entry.status)})
                </span>
              </p>
              {entry.failed && (
                <p role="note" className="rounded border border-red-700 bg-red-50 p-2 text-red-800">
                  ⚠ {t("failed")}
                  {entry.error ? ` ${entry.error}` : ""}
                </p>
              )}
              {entry.bodyRendered && (
                <details>
                  <summary className="cursor-pointer underline">{t("view")}</summary>
                  {/* sandbox="" grants nothing: no scripts, no same origin, no forms. */}
                  <iframe sandbox="" srcDoc={entry.bodyRendered} referrerPolicy="no-referrer" title={t("bodyTitle")} className="mt-2 min-h-[40vh] w-full rounded border bg-white" />
                </details>
              )}
            </div>
          )}
          {entry.kind === "interview" && (
            <p className="font-medium">
              {t("interview", { minutes: entry.durationMinutes })} ({t(`interviewStatuses.${entry.status}`)})
            </p>
          )}
          {entry.kind === "scorecard" && (
            <p>
              <span className="font-medium">{t("scorecard", { name: entry.interviewer })}</span>: {t("rating", { rating: entry.overallRating })},{" "}
              {entry.thumbsUp ? t("thumbsUp") : t("thumbsDown")}
            </p>
          )}
          {entry.kind === "offer" && (
            <div className="space-y-1">
              <p className="font-medium">{t("offer", { title: entry.jobTitle })}</p>
              <p>
                {t("offerApproval", { status: t(`offerApprovalStatuses.${entry.approvalStatus}`) })} ·{" "}
                {t("offerResponse", { response: t(`offerResponses.${entry.candidateResponse}`) })}
              </p>
              {entry.sentAt && <p>{t.rich("offerSent", { time: () => time(entry.sentAt!) })}</p>}
              {entry.respondedAt && <p>{t.rich("offerResponded", { time: () => time(entry.respondedAt!) })}</p>}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
