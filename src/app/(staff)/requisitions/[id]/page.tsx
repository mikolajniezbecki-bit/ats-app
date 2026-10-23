// Requisition detail (ats-project-scope.md §5.2, §5.1, V3a, V9): 404 outside
// the caller's scope; warns when the recruiter or hiring manager is inactive.
import { getTranslations } from "next-intl/server";
import { ApprovalActions } from "@/components/requisitions/approval-actions";
import { PrescreenEditor } from "@/components/requisitions/prescreen-editor";
import { APPROVER_ROLES, latestRequisitionApprovalEvent, requisitionApproval } from "@/server/approvals";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sanitizeDescription } from "@/server/domain/requisitions/description";
import { requirePermission } from "@/server/policy/guards";
import { can } from "@/server/policy/permissions";
import { canEditQuestions, listQuestionRows, questionsEditable, storedDefinition } from "@/server/prescreen";
import { getRequisitionDetail, isFirstApprovalPending } from "@/server/requisitions";
import { listActiveUsers } from "@/server/users";

export const dynamic = "force-dynamic";

export default async function RequisitionPage({ params }: PageProps<"/requisitions/[id]">) {
  const { id } = await params;
  const user = await requirePermission("requisition.read", undefined, `/requisitions/${encodeURIComponent(id)}`);
  const detail = await getRequisitionDetail(user, id);
  if (!detail) notFound();
  const { requisition, template } = detail;
  const t = await getTranslations("Requisitions");
  const a = await getTranslations("Approvals.panel");
  const pendingFirst = isFirstApprovalPending(requisition);
  const canSubmit = requisition.state === "DRAFT" && can(user, "requisition.edit", requisition);
  // A2: the picker never offers the current user.
  const approvers = canSubmit
    ? (await listActiveUsers({ roles: APPROVER_ROLES })).filter((approver) => approver.id !== user.id).map(({ id: userId, name }) => ({ id: userId, name }))
    : null;
  const approval = requisitionApproval(requisition);
  const latest = await latestRequisitionApprovalEvent(requisition.id);
  const approverName = detail.approver?.name ?? "—";
  const utc = (date: Date) => date.toISOString().slice(0, 16).replace("T", " ");
  const questions = (await listQuestionRows(requisition.id)).map((row) => ({ id: row.id, isActive: row.isActive, ...storedDefinition(row) }));
  const customFields = (requisition.customFieldsJson as Record<string, string | number | boolean | null>) ?? {};
  const named = (ref: { label: string; isActive: boolean }) => (ref.isActive ? ref.label : t("inactive", { label: ref.label }));
  const person = (ref: { name: string; isActive: boolean }) => (ref.isActive ? ref.name : t("inactive", { label: ref.name }));
  const customValue = (value: string | number | boolean | null | undefined) =>
    value === null || value === undefined ? t("fields.notSet") : typeof value === "boolean" ? t(value ? "fields.yes" : "fields.no") : String(value);

  const rows: [string, string][] = [
    [t("fields.title"), requisition.title],
    [t("columns.state"), t(`states.${requisition.state}`)],
    [t("fields.template"), template ? template.name : t("noTemplate")],
    [t("fields.department"), named(detail.department)],
    [t("fields.location"), named(detail.location)],
    [t("fields.legalEntity"), named(detail.legalEntity)],
    [t("fields.hiringManager"), person(detail.hiringManager)],
    [t("fields.recruiter"), person(detail.recruiter)],
    [t("fields.openingsCount"), String(requisition.openingsCount)],
    [t("fields.postingType"), t(`postingTypes.${requisition.postingType}`)],
  ];
  if (requisition.privateSlug) rows.push([t("fields.privateLink"), `/jobs/p/${requisition.privateSlug}`]);

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <Link href="/requisitions" className="text-sm underline">
        {t("back")}
      </Link>
      <h1 className="text-2xl font-semibold">
        {requisition.reqNumber} · {requisition.title}
      </h1>
      {!detail.recruiter.isActive && (
        <p role="alert" className="rounded border border-amber-700 bg-amber-50 px-3 py-2 text-amber-900">
          {t("recruiterInactive")}
        </p>
      )}
      {!detail.hiringManager.isActive && (
        <p role="alert" className="rounded border border-amber-700 bg-amber-50 px-3 py-2 text-amber-900">
          {t("hiringManagerInactive")}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {requisition.state === "DRAFT" && can(user, "requisition.edit", requisition) && (
          <Link href={`/requisitions/${requisition.id}/edit`} className="rounded bg-black px-4 py-2 text-white">
            {t("edit")}
          </Link>
        )}
        {can(user, "requisition.create") && (
          <Link href={`/requisitions/new?from=${requisition.id}`} className="rounded border px-4 py-2">
            {t("duplicate")}
          </Link>
        )}
      </div>
      <section aria-labelledby="approval-heading" className="max-w-3xl space-y-2">
        <h2 id="approval-heading" className="text-xl font-semibold">
          {a("title")}
        </h2>
        {requisition.state === "PENDING_APPROVAL" && requisition.submittedAt && (
          <p data-testid="approval-status">{a("pending", { approver: approverName, time: utc(requisition.submittedAt) })}</p>
        )}
        {pendingFirst && (
          <p role="status" className="rounded border border-amber-700 bg-amber-50 px-3 py-2 text-amber-900">
            {a("locked")}
          </p>
        )}
        {latest && latest.event !== "SUBMITTED" && (
          <p data-testid="approval-latest">
            {a("latest", { event: a(`events.${latest.event}`), actor: latest.actor ?? "—", time: utc(latest.createdAt) })}
            {latest.comment && <span className="block">{a("latestComment", { comment: latest.comment })}</span>}
          </p>
        )}
        <ApprovalActions
          requisitionId={requisition.id}
          version={requisition.version}
          approvers={approvers}
          canDecide={can(user, "approval.decide", approval)}
          canWithdraw={can(user, "approval.withdraw", approval)}
        />
      </section>
      <section aria-labelledby="details-heading" className="space-y-2">
        <h2 id="details-heading" className="text-xl font-semibold">
          {t("details")}
        </h2>
        <dl className="grid max-w-3xl grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          {rows.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="font-medium">{term}</dt>
              <dd data-testid={`detail-${term}`}>{value}</dd>
            </div>
          ))}
          {template?.schema.map((field) => (
            <div key={field.key} className="contents">
              <dt className="font-medium">{field.label}</dt>
              <dd>{customValue(customFields[field.key])}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="description-heading" className="max-w-3xl space-y-2">
        <h2 id="description-heading" className="text-xl font-semibold">
          {t("fields.description")}
        </h2>
        <div
          className="[&_a]:underline [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-6"
          dangerouslySetInnerHTML={{ __html: sanitizeDescription(requisition.descriptionHtml) }}
        />
      </section>
      <PrescreenEditor requisitionId={requisition.id} questions={questions} canEdit={canEditQuestions(user, requisition) && questionsEditable(requisition)} />
    </main>
  );
}
