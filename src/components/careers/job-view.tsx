// A public job page (ats-project-scope.md §5.3): title, department, location
// and the sanitized description with an Apply link while published; only the
// title and "no longer accepting applications" otherwise.
import { getTranslations } from "next-intl/server";
import { sanitizeDescription } from "@/server/domain/requisitions/description";
import type { PublicJob } from "@/server/careers";

export async function JobView({ job, applyHref }: { job: PublicJob; applyHref: string }) {
  const t = await getTranslations("Careers");
  if (!job.isPublished) {
    return (
      <article className="space-y-4">
        <h1 className="text-3xl font-semibold">{job.title}</h1>
        <p role="status" className="rounded border border-neutral-400 bg-neutral-50 px-4 py-3">
          {t("closed")}
        </p>
      </article>
    );
  }
  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold">{job.title}</h1>
        <p className="text-neutral-700">
          <span className="sr-only">{t("department")}: </span>
          {job.department} · <span className="sr-only">{t("location")}: </span>
          {job.location}
        </p>
      </header>
      <div
        className="space-y-3 leading-relaxed [&_a]:text-blue-800 [&_a]:underline [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:text-lg [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
        dangerouslySetInnerHTML={{ __html: sanitizeDescription(job.descriptionHtml) }}
      />
      {/* A full page load, so the apply page gets its own CSP (Turnstile, F6); a client-side navigation keeps this page's. */}
      <a href={applyHref} className="inline-block rounded bg-neutral-900 px-6 py-3 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900">
        {t("apply")}
      </a>
    </article>
  );
}
