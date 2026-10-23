// Inline PDF viewer (ats-project-scope.md F5, V11): a server component that
// asks the file-link service, which runs the policy check, and embeds the
// direct signed Blob link. Each render issues a fresh 5-minute link, so
// reloading the page after expiry works again.
import { getTranslations } from "next-intl/server";
import { forbidden, notFound } from "next/navigation";
import { issueFileLink } from "@/server/files/links";
import type { PolicyUser } from "@/server/policy/permissions";

export async function PdfViewer({ fileId, user }: { fileId: string; user: PolicyUser }) {
  const result = await issueFileLink(user, fileId);
  if (result.status === "not-found") notFound();
  if (result.status === "forbidden") forbidden();
  const t = await getTranslations("Files");

  return (
    <div className="flex flex-1 flex-col gap-2">
      <a href={result.link.url} target="_blank" rel="noopener noreferrer" className="self-end text-sm underline">
        {t("openInNewTab")}
      </a>
      <iframe src={result.link.url} title={t("viewerTitle")} className="min-h-[80vh] w-full flex-1 rounded border" />
    </div>
  );
}
