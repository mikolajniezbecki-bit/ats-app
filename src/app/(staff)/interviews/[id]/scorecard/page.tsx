// A participant's scorecard for one interview (ats-project-scope.md I9, V8,
// I6): the interview time in the browser's zone, the job, the candidate and
// the form. 404 unless the caller is on the interview's panel (V9).
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/local-time";
import { ScorecardForm } from "@/components/scorecards/scorecard-form";
import { maxUploadBytes } from "@/server/files/store-pdf";
import { requirePermission } from "@/server/policy/guards";
import { getScorecardPage } from "@/server/scorecards";

export const dynamic = "force-dynamic";

export default async function ScorecardPage({ params }: PageProps<"/interviews/[id]/scorecard">) {
  const { id } = await params;
  const user = await requirePermission("staff.area", undefined, `/interviews/${encodeURIComponent(id)}/scorecard`);
  const page = await getScorecardPage(user, id);
  if (!page) notFound();
  const t = await getTranslations("Scorecards");
  const { maxMb } = await maxUploadBytes();
  const iso = (date: Date | null) => (date ? date.toISOString() : null);
  // A submitted scorecard says so itself; other refusals are shown as the API's text.
  const refusal = page.refusal && page.refusal !== "submitted" ? t(`errors.${page.refusal === "notParticipant" ? "forbidden" : page.refusal}`) : null;

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <dl className="grid max-w-3xl grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="font-medium">{t("interview")}</dt>
        <dd>
          <LocalTime value={page.interview.startsAtUtc.toISOString()} />
        </dd>
        <dt className="font-medium">{t("job")}</dt>
        <dd>{page.jobTitle}</dd>
        <dt className="font-medium">{t("candidate")}</dt>
        <dd>{page.candidate ?? t("anonymized")}</dd>
        {page.scorecard?.submittedAt && (
          <>
            <dt className="font-medium">{t("submittedAt")}</dt>
            <dd>
              <LocalTime value={page.scorecard.submittedAt.toISOString()} />
            </dd>
          </>
        )}
      </dl>
      <ScorecardForm
        interviewId={page.interview.id}
        scorecard={
          page.scorecard
            ? {
                thumbsUp: page.scorecard.thumbsUp,
                overallRating: page.scorecard.overallRating,
                comments: page.scorecard.comments,
                submittedAt: iso(page.scorecard.submittedAt),
                reopenedAt: iso(page.scorecard.reopenedAt),
              }
            : null
        }
        notesFileId={page.notesFileId}
        maxMb={maxMb}
        refusal={refusal}
      />
    </main>
  );
}
