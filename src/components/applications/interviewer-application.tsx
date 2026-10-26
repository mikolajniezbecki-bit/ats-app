// An application as an Interviewer sees it (ats-project-scope.md V5, V6, V7,
// I6): only the V6 allowlist from the read model, so nothing else can be
// rendered by mistake. Times in the browser's zone.
import { getTranslations } from "next-intl/server";
import { LocalTime } from "@/components/local-time";
import { PdfViewer } from "@/components/pdf-viewer";
import type { InterviewerApplicationView } from "@/server/applications/views";
import type { PolicyUser } from "@/server/policy/permissions";

export async function InterviewerApplication({ view, user }: { view: InterviewerApplicationView; user: PolicyUser }) {
  const d = await getTranslations("Applications.detail");
  const i = await getTranslations("Interviews");
  const sc = await getTranslations("Scorecards");
  const f = await getTranslations("Feedback");
  const name = `${view.application.firstName ?? ""} ${view.application.lastName ?? ""}`.trim();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{name}</h1>
      <dl className="grid max-w-3xl grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="font-medium">{d("fields.email")}</dt>
        <dd className="break-all">{view.application.email}</dd>
        <dt className="font-medium">{d("fields.phone")}</dt>
        <dd>{view.application.phone}</dd>
        <dt className="font-medium">{d("fields.requisition")}</dt>
        <dd>
          {view.requisition.reqNumber} · {view.requisition.title}
        </dd>
      </dl>

      <section aria-labelledby="documents-heading" className="space-y-3">
        <h2 id="documents-heading" className="text-xl font-semibold">
          {d("documents")}
        </h2>
        {view.documents.length === 0 && <p className="text-sm">{d("noDocuments")}</p>}
        {view.documents.map((file) => (
          <div key={file.id} className="space-y-1" data-testid={`document-${file.kind}`}>
            <h3 className="font-medium">{d(`kinds.${file.kind}`)}</h3>
            {file.deleted ? <p className="text-sm">{d("fileDeleted")}</p> : <PdfViewer fileId={file.id} user={user} title={d(`kinds.${file.kind}`)} />}
          </div>
        ))}
      </section>

      <section aria-labelledby="interviews-heading" className="space-y-2">
        <h2 id="interviews-heading" className="text-xl font-semibold">
          {i("title")}
        </h2>
        <ul className="max-w-4xl space-y-2">
          {view.interviews.map((interview) => (
            <li key={interview.id} className="rounded border p-3 text-sm" data-testid={`interview-${interview.id}`}>
              <p className="font-medium">
                <LocalTime value={interview.startsAtUtc.toISOString()} /> · {i("durationValue", { minutes: interview.durationMinutes })} · {i(`statuses.${interview.status}`)}
              </p>
              <p className="break-all">{interview.locationOrLink}</p>
              <p>
                {i("fields.participants")}: {interview.participants.join(", ")}
              </p>
              <a href={`/interviews/${interview.id}/scorecard`} className="mt-1 inline-block underline">
                {i("scorecard")}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="feedback-heading" className="space-y-2">
        <h2 id="feedback-heading" className="text-xl font-semibold">
          {f("title")}
        </h2>
        {view.scorecards.length === 0 ? (
          <p className="text-sm">{f("empty")}</p>
        ) : (
          <ul className="max-w-4xl space-y-2 text-sm">
            {view.scorecards.map((scorecard) => (
              <li key={scorecard.id} className="rounded border p-3" data-testid={`scorecard-${scorecard.id}`}>
                <p className="font-medium">
                  {f("entry", { interviewer: scorecard.interviewer, rating: scorecard.overallRating, thumbs: sc(scorecard.thumbsUp ? "thumbsUp" : "thumbsDown") })}
                  {scorecard.own && !scorecard.submittedAt && <span className="ml-2 text-xs">({f("draft")})</span>}
                </p>
                {scorecard.comments && <p className="whitespace-pre-wrap">{scorecard.comments}</p>}
                {scorecard.own && (
                  <a href={`/interviews/${scorecard.interviewId}/scorecard`} className="underline">
                    {i("scorecard")}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
