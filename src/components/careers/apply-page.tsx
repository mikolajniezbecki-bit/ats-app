// The Quick Apply page for one job (ats-project-scope.md §5.3): the form
// while published, the closed message otherwise.
import { getTranslations } from "next-intl/server";
import { ApplyForm } from "@/components/careers/apply-form";
import { loadApplyForm } from "@/server/apply";
import type { PublicJob } from "@/server/careers";

export async function ApplyPage({ job, route }: { job: PublicJob; route: { kind: "external" | "private"; key: string } }) {
  const t = await getTranslations("Apply");
  const careers = await getTranslations("Careers");
  if (!job.isPublished) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-semibold">{job.title}</h1>
        <p role="status" className="rounded border border-neutral-400 bg-neutral-50 px-4 py-3">
          {careers("closed")}
        </p>
      </div>
    );
  }
  const form = await loadApplyForm(job);
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold">{t("title", { title: job.title })}</h1>
        <p className="text-neutral-700">
          {job.department} · {job.location}
        </p>
      </header>
      <ApplyForm route={route} questions={form.questions} privacy={form.privacy} maxMb={form.maxMb} />
    </div>
  );
}
