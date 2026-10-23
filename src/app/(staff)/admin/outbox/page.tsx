// The Outbox (tech-stack.md §9, ats-project-scope.md E6): every logged email,
// newest first, 50 per page, with a status filter. Admin only.
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { EMAIL_STATUSES } from "@/server/db/schema";
import { type EmailStatus, listOutbox } from "@/server/email/outbox";
import { requirePermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";

function href(status: EmailStatus | undefined, page = 1) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/admin/outbox?${query}` : "/admin/outbox";
}

export default async function OutboxPage({ searchParams }: PageProps<"/admin/outbox">) {
  await requirePermission("outbox.view", undefined, "/admin/outbox");
  const params = await searchParams;
  const status = EMAIL_STATUSES.find((value) => value === params.status);
  const page = Number.parseInt(String(params.page ?? "1"), 10) || 1;
  const t = await getTranslations("AdminOutbox");
  const statuses = await getTranslations("EmailStatuses");
  const format = await getFormatter();
  const outbox = await listOutbox({ status, page });

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <nav aria-label={t("filterLabel")} className="flex flex-wrap gap-3 text-sm">
        <span>{t("filterLabel")}:</span>
        {[undefined, ...EMAIL_STATUSES].map((value) => (
          <Link
            key={value ?? "all"}
            href={href(value)}
            aria-current={value === status ? "page" : undefined}
            className="underline aria-[current=page]:font-semibold aria-[current=page]:no-underline"
          >
            {value ? statuses(value) : t("all")}
          </Link>
        ))}
      </nav>
      {outbox.rows.length === 0 ? (
        <p className="text-sm">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-1 pr-4">{t("columns.recipient")}</th>
                <th className="py-1 pr-4">{t("columns.subject")}</th>
                <th className="py-1 pr-4">{t("columns.status")}</th>
                <th className="py-1 pr-4">{t("columns.time")}</th>
                <th className="py-1">{t("columns.application")}</th>
              </tr>
            </thead>
            <tbody>
              {outbox.rows.map((row) => {
                const removed = row.recipient === null && row.subject === null;
                return (
                  <tr key={row.id} className="border-b align-top" data-testid={`outbox-${row.id}`}>
                    <td className="py-2 pr-4">{removed ? <em>{t("removed")}</em> : row.recipient}</td>
                    <td className="py-2 pr-4">
                      <Link href={`/admin/outbox/${row.id}`} className="underline">
                        {removed ? t("removed") : row.subject}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">{statuses(row.status)}</td>
                    <td className="py-2 pr-4">{row.time ? `${format.dateTime(row.time, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC` : t("none")}</td>
                    <td className="py-2">
                      {row.applicationId ? (
                        <Link href={`/applications/${row.applicationId}`} className="underline">
                          {t("openApplication")}
                        </Link>
                      ) : (
                        t("none")
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label={t("pageLabel")} className="flex items-center gap-4 text-sm">
        {outbox.page > 1 && (
          <Link href={href(status, outbox.page - 1)} className="underline">
            {t("previous")}
          </Link>
        )}
        <span>{t("pageOf", { page: outbox.page, pages: outbox.pages })}</span>
        {outbox.page < outbox.pages && (
          <Link href={href(status, outbox.page + 1)} className="underline">
            {t("next")}
          </Link>
        )}
      </nav>
    </main>
  );
}
