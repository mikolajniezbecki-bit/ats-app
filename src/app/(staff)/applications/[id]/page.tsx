// One application (ats-project-scope.md §5.4 Recruiter workbench, E5, F5,
// R9, RT4, V11): the candidate, the documents in the inline PDF viewer, the
// pre-screening answers, the status control, the interviews (I1–I7), the
// feedback, the offers and the timeline. Admins and Recruiters manage it;
// Hiring Managers in V3a read it all (V4); an Interviewer in V5 gets only the
// V6 allowlist. 404 outside the caller's scope (V9).
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApplicationTimeline } from "@/components/applications/application-timeline";
import { InterviewerApplication } from "@/components/applications/interviewer-application";
import { InterviewsPanel } from "@/components/applications/interviews-panel";
import { OffersPanel } from "@/components/applications/offers-panel";
import { ReopenScorecardButton } from "@/components/applications/reopen-scorecard-button";
import { StatusControl } from "@/components/applications/status-control";
import { LocalTime } from "@/components/local-time";
import { PdfViewer } from "@/components/pdf-viewer";
import { getApplicationDetail } from "@/server/applications";
import { getApplicationFeedback } from "@/server/applications/feedback";
import { getInterviewerApplication } from "@/server/applications/views";
import { CURRENCIES } from "@/server/domain/offers/currencies";
import { listOffersForPage, offerCreateBlock } from "@/server/offers";
import { listOfferApproverOptions } from "@/server/approvals/offers";
import { listActiveTemplates } from "@/server/templates";
import { APPLICATION_STATUSES } from "@/server/db/schema";
import { awaitingOutcome } from "@/server/domain/interviews";
import { isOpenStatus } from "@/server/domain/pipeline";
import { listApplicationInterviews, listParticipantOptions, utcToLocal } from "@/server/interviews";
import { requirePermission } from "@/server/policy/guards";
import { can } from "@/server/policy/permissions";

export const dynamic = "force-dynamic";

export default async function ApplicationPage({ params }: PageProps<"/applications/[id]">) {
  const { id } = await params;
  const user = await requirePermission("application.read", undefined, `/applications/${encodeURIComponent(id)}`);
  if (user.role === "INTERVIEWER") {
    const view = await getInterviewerApplication(user, id);
    if (!view) notFound();
    return <InterviewerApplication view={view} user={user} />;
  }
  const detail = await getApplicationDetail(user, id);
  if (!detail) notFound();
  const { application, requisition, anonymized } = detail;
  // R4: on a HIRED application the control lists only an Admin's corrections.
  const hiredCorrection = application.status === "HIRED" && can(user, "application.correctHired");
  const t = await getTranslations("Applications");
  const d = await getTranslations("Applications.detail");
  const statuses = await getTranslations("Statuses");
  const statusLabels = Object.fromEntries(APPLICATION_STATUSES.map((status) => [status, statuses(status)]));
  const name = anonymized ? d("anonymizedName") : `${application.firstName} ${application.lastName}`;
  const when = (value: Date, dateOnly = false) => <LocalTime value={value.toISOString()} dateOnly={dateOnly} />;
  const i = await getTranslations("Interviews");
  const now = new Date();
  const canManageInterviews = can(user, "interview.manage");
  const interviews = (await listApplicationInterviews(application.id, now)).map((interview) => ({
    id: interview.id,
    startsAtUtc: interview.startsAtUtc.toISOString(),
    startLocal: utcToLocal(interview.startsAtUtc, interview.timezone),
    durationMinutes: interview.durationMinutes,
    timezone: interview.timezone,
    locationOrLink: interview.locationOrLink,
    status: interview.status,
    icsSequence: interview.icsSequence,
    awaitingOutcome: awaitingOutcome(interview, now),
    started: interview.startsAtUtc <= now,
    participants: interview.participants,
  }));
  const participantOptions = canManageInterviews ? await listParticipantOptions(application.id) : [];
  const feedback = await getApplicationFeedback(user, application.id);
  const f = await getTranslations("Feedback");
  const o = await getTranslations("Offers");
  const offerRows = can(user, "offer.read") ? await listOffersForPage(user, application.id) : null;
  const canManageOffers = can(user, "offer.manage");
  const offerTemplates = canManageOffers ? await listActiveTemplates({ type: "OFFER" }) : [];
  const createBlock = canManageOffers ? await offerCreateBlock(application.id) : undefined;
  // A1, A4: the approver pickers (the panel leaves out who can't approve).
  const offerApprovers = canManageOffers || can(user, "approval.reassign") ? await listOfferApproverOptions([]) : [];
  const sc = await getTranslations("Scorecards");

  const fields: [string, React.ReactNode][] = [
    ...(anonymized
      ? []
      : ([
          [d("fields.email"), application.email],
          [d("fields.phone"), application.phone],
        ] as [string, React.ReactNode][])),
    [
      d("fields.requisition"),
      // V3b: an offer approver outside V3a sees the header but no requisition pages.
      requisition.visible ? (
        <Link key="requisition" href={`/requisitions/${requisition.id}`} className="underline">
          {requisition.reqNumber} · {requisition.title}
        </Link>
      ) : (
        `${requisition.reqNumber} · ${requisition.title}`
      ),
    ],
    [d("fields.department"), requisition.department],
    [d("fields.location"), requisition.location],
    [d("fields.openings"), String(requisition.openingsCount)],
    [d("fields.status"), statuses(application.status)],
    [
      d("fields.score"),
      <span key="score">
        {application.prescreenScore}
        {application.isDisqualified && <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-900">{t("disqualified")}</span>}
      </span>,
    ],
    [d("fields.source"), t(`sources.${application.source}`)],
    [d("fields.applied"), when(application.appliedAt)],
    [d("fields.consent"), d.rich("fields.consentValue", { version: application.consentVersion, date: () => when(application.consentAcceptedAt) })],
    [d("fields.version"), String(application.version)],
  ];

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      {detail.hasFailedEmail && (
        <p role="alert" className="rounded border border-red-700 bg-red-50 p-3 text-sm text-red-800">
          {d("failedBanner")}
        </p>
      )}
      {requisition.visible && (
        <Link href={`/requisitions/${requisition.id}/applications`} className="text-sm underline">
          {t("listTitle", { reqNumber: requisition.reqNumber, title: requisition.title })}
        </Link>
      )}
      <h1 className="text-2xl font-semibold">{name}</h1>
      {anonymized && <p className="text-sm">{d("anonymizedNotice")}</p>}
      <dl className="grid max-w-3xl grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        {fields.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-medium">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="others-heading" className="space-y-2">
        <h2 id="others-heading" className="text-xl font-semibold">
          {d("others")}
        </h2>
        {detail.others.length === 0 ? (
          <p className="text-sm">{d("noOthers")}</p>
        ) : (
          <ul className="list-disc pl-5 text-sm">
            {detail.others.map((other) => (
              <li key={other.id}>
                <Link href={`/applications/${other.id}`} className="underline">
                  {other.reqNumber} · {other.title}
                </Link>{" "}
                ({statuses(other.status)})
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* RT3: an anonymized application can't change status, so no control is offered. */}
      {can(user, "application.changeStatus") && !anonymized && (
        <section aria-labelledby="status-heading" className="space-y-2">
          <h2 id="status-heading" className="text-xl font-semibold">
            {hiredCorrection ? t("status.correctTitle") : t("status.title")}
          </h2>
          <StatusControl
            applicationId={application.id}
            version={application.version}
            targets={detail.targets}
            statusLabels={statusLabels}
            correction={hiredCorrection}
          />
        </section>
      )}

      <section aria-labelledby="documents-heading" className="space-y-3">
        <h2 id="documents-heading" className="text-xl font-semibold">
          {d("documents")}
        </h2>
        {/* F8, task 40 Q5: the purge deleted the files; nothing is linked. */}
        {anonymized && <p className="text-sm">{d("filesRemoved")}</p>}
        {!anonymized && detail.documents.length === 0 && <p className="text-sm">{d("noDocuments")}</p>}
        {detail.documents.map((file) => (
          <div key={file.id} className="space-y-1" data-testid={`document-${file.kind}`}>
            <h3 className="font-medium">{d(`kinds.${file.kind}`)}</h3>
            {file.deleted ? <p className="text-sm">{d("fileDeleted")}</p> : <PdfViewer fileId={file.id} user={user} title={d(`kinds.${file.kind}`)} />}
          </div>
        ))}
      </section>

      {!anonymized && (
        <section aria-labelledby="prescreen-heading" className="space-y-2">
          <h2 id="prescreen-heading" className="text-xl font-semibold">
            {d("prescreen")}
          </h2>
          {detail.answers.length === 0 ? (
            <p className="text-sm">{d("noQuestions")}</p>
          ) : (
            <table className="w-full max-w-4xl text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-1 pr-4">{d("question")}</th>
                  <th className="py-1 pr-4">{d("answer")}</th>
                  <th className="py-1">{d("points")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.answers.map((answer) => (
                  <tr key={answer.questionId} className="border-b align-top">
                    <td className="py-2 pr-4">
                      {answer.text}
                      {!answer.questionActive && <span className="ml-2 text-xs text-gray-700">{d("inactiveQuestion")}</span>}
                    </td>
                    <td className="py-2 pr-4">
                      {!answer.answered ? (
                        <em>{d("notAnswered")}</em>
                      ) : answer.type === "MULTI" ? (
                        <ul className="list-disc pl-5">
                          {answer.answer.map((label) => (
                            <li key={label}>{label}</li>
                          ))}
                        </ul>
                      ) : (
                        <span className="whitespace-pre-wrap">{answer.answer[0]}</span>
                      )}
                    </td>
                    <td className="py-2">{answer.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section aria-labelledby="interviews-heading" className="space-y-2">
        <h2 id="interviews-heading" className="text-xl font-semibold">
          {i("title")}
        </h2>
        <InterviewsPanel
          applicationId={application.id}
          interviews={interviews}
          participantOptions={participantOptions}
          canManage={canManageInterviews}
          canSchedule={isOpenStatus(application.status) && !anonymized}
          currentUserId={user.id}
        />
      </section>

      {feedback && (
        <section aria-labelledby="feedback-heading" className="space-y-2" data-testid="feedback">
          <h2 id="feedback-heading" className="text-xl font-semibold">
            {f("title")}
          </h2>
          {feedback.summary.count === 0 ? (
            <p className="text-sm">{f("empty")}</p>
          ) : (
            <>
              <p className="text-sm" data-testid="feedback-summary">
                {f("average", { average: feedback.summary.average ?? "" })} · {f("thumbs", { up: feedback.summary.thumbsUp, down: feedback.summary.thumbsDown })}
              </p>
              <ul className="max-w-4xl space-y-2 text-sm">
                {feedback.scorecards.map((scorecard) => (
                  <li key={scorecard.id} className="rounded border p-3" data-testid={`scorecard-${scorecard.id}`}>
                    <p className="font-medium">
                      {f("entry", { interviewer: scorecard.interviewer, rating: scorecard.overallRating, thumbs: sc(scorecard.thumbsUp ? "thumbsUp" : "thumbsDown") })}
                      {can(user, "scorecard.reopen") && <ReopenScorecardButton scorecardId={scorecard.id} />}
                    </p>
                    {scorecard.comments && <p className="whitespace-pre-wrap">{scorecard.comments}</p>}
                    {scorecard.notesFileId && (
                      <Link href={`/files/${scorecard.notesFileId}`} className="underline">
                        {f("notes")}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {offerRows && (
        <section aria-labelledby="offers-heading" className="space-y-2" data-testid="offers">
          <h2 id="offers-heading" className="text-xl font-semibold">
            {o("title")}
          </h2>
          <OffersPanel
            applicationId={application.id}
            offers={offerRows.map((offer) => ({
              id: offer.id,
              version: offer.version,
              jobTitle: offer.jobTitle,
              salary: offer.salary,
              currency: offer.currency,
              startDate: offer.startDate,
              templateId: offer.templateId,
              templateName: offer.templateName,
              approvalStatus: offer.approvalStatus,
              candidateResponse: offer.candidateResponse,
              createdBy: offer.createdBy,
              createdAt: offer.createdAt.toISOString(),
              frozen: offer.frozen,
              editable: offer.editable,
              needsReapproval: offer.needsReapproval,
              letterPending: offer.letterPending,
              sentAt: offer.sentAt?.toISOString() ?? null,
              respondable: offer.respondable,
              discardable: offer.discardable,
              submittable: offer.submittable,
              decidable: offer.decidable,
              withdrawable: offer.withdrawable,
              reassignable: offer.reassignable,
              approverId: offer.approverId,
              submittedByUserId: offer.submittedByUserId,
              approver: offer.approver,
              submitter: offer.submitter,
              submittedAt: offer.submittedAt?.toISOString() ?? null,
              latestEvent: offer.latestEvent ? { ...offer.latestEvent, createdAt: offer.latestEvent.createdAt.toISOString() } : null,
            }))}
            approvers={offerApprovers}
            currentUserId={user.id}
            createBlock={canManageOffers ? (createBlock ? o(`errors.${createBlock}`) : "") : null}
            templates={offerTemplates}
            currencies={CURRENCIES}
            defaults={{
              jobTitle: requisition.title,
              templateId: offerTemplates.find((template) => template.name === "Default offer letter")?.id ?? "",
              currency: "EUR",
            }}
          />
        </section>
      )}

      <section aria-labelledby="timeline-heading" className="space-y-2">
        <h2 id="timeline-heading" className="text-xl font-semibold">
          {d("timeline")}
        </h2>
        {detail.timeline.length === 0 ? <p className="text-sm">{d("noTimeline")}</p> : <ApplicationTimeline entries={detail.timeline} />}
      </section>
    </main>
  );
}
