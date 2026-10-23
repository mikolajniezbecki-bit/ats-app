// One logged email (tech-stack.md §9): its headers and status, the HTML body
// in a sandboxed iframe that can run nothing and fetch nothing remote (the
// page's CSP applies to srcdoc), the `.ics` download and the attachments
// through signed links (V11). Admin only.
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getOutboxMessage } from "@/server/email/outbox";
import { requirePermission } from "@/server/policy/guards";
import { getSetting } from "@/server/settings";
import { OpenAttachmentButton } from "./open-attachment";

export const dynamic = "force-dynamic";

export default async function OutboxMessagePage({ params }: PageProps<"/admin/outbox/[id]">) {
  const { id } = await params;
  await requirePermission("outbox.view", undefined, `/admin/outbox/${encodeURIComponent(id)}`);
  const email = await getOutboxMessage(id);
  if (!email) notFound();
  const t = await getTranslations("AdminOutbox");
  const statuses = await getTranslations("EmailStatuses");
  const format = await getFormatter();
  const when = (value: Date | null) => (value ? `${format.dateTime(value, { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" })} UTC` : t("none"));
  const removed = email.recipient === null && email.subject === null;

  const fields: [string, React.ReactNode][] = [
    [t("fields.from"), await getSetting("SENDER_EMAIL")],
    [t("fields.to"), removed ? <em>{t("removed")}</em> : email.recipient],
    [t("fields.cc"), email.cc ?? t("none")],
    [t("fields.replyTo"), email.replyTo ?? t("none")],
    [t("fields.subject"), removed ? <em>{t("removed")}</em> : email.subject],
    [t("fields.status"), statuses(email.status)],
    [t("fields.scheduledFor"), when(email.scheduledFor)],
    [t("fields.sentAt"), when(email.sentAt)],
    [t("fields.messageId"), email.providerMessageId ?? t("none")],
    ...(email.status === "FAILED" ? ([[t("fields.error"), email.error ?? t("none")]] as [string, React.ReactNode][]) : []),
    [t("fields.template"), email.templateName ?? t("none")],
    [
      t("fields.application"),
      email.applicationId ? (
        <Link href={`/applications/${email.applicationId}`} className="underline">
          {t("openApplication")}
        </Link>
      ) : (
        t("none")
      ),
    ],
  ];

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <Link href="/admin/outbox" className="text-sm underline">
        {t("back")}
      </Link>
      <h1 className="text-2xl font-semibold">{t("detailTitle")}</h1>
      <dl className="grid max-w-3xl grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        {fields.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-medium">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      {email.icsContent && (
        <a href={`/api/admin/outbox/${email.id}/ics`} className="self-start underline" download>
          {t("downloadIcs")}
        </a>
      )}
      {email.attachments.length > 0 && (
        <section aria-labelledby="attachments-heading" className="space-y-1">
          <h2 id="attachments-heading" className="font-semibold">
            {t("attachments")}
          </h2>
          <ul className="space-y-1 text-sm">
            {email.attachments.map((file) => (
              <li key={file.id} className="flex items-center gap-3">
                <span>{file.name ?? t("unnamed")}</span>
                {file.deleted ? <em>{t("attachmentDeleted")}</em> : <OpenAttachmentButton fileId={file.id} name={file.name ?? t("unnamed")} />}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="body-heading" className="flex flex-1 flex-col gap-2">
        <h2 id="body-heading" className="font-semibold">
          {t("body")}
        </h2>
        {email.bodyRendered ? (
          // sandbox="" grants nothing: no scripts, no same origin, no forms.
          <iframe sandbox="" srcDoc={email.bodyRendered} referrerPolicy="no-referrer" title={t("bodyTitle")} className="min-h-[60vh] w-full rounded border bg-white" />
        ) : (
          <p className="text-sm">{removed ? t("removed") : t("noBody")}</p>
        )}
      </section>
    </main>
  );
}
