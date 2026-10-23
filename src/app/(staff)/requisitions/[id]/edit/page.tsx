// Edit a requisition (ats-project-scope.md §5.2; tech-stack.md D7): the form
// carries the version it loaded. Stored inactive values stay selectable,
// labelled "(inactive)".
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { forbidden, notFound } from "next/navigation";
import { RequisitionForm } from "@/components/requisitions/requisition-form";
import { requirePermission } from "@/server/policy/guards";
import { can } from "@/server/policy/permissions";
import { getRequisitionDetail } from "@/server/requisitions";
import { requisitionFormOptions } from "@/server/requisitions/form-options";

export const dynamic = "force-dynamic";

export default async function EditRequisitionPage({ params }: PageProps<"/requisitions/[id]/edit">) {
  const { id } = await params;
  const user = await requirePermission("requisition.edit", undefined, `/requisitions/${encodeURIComponent(id)}/edit`);
  const detail = await getRequisitionDetail(user, id);
  if (!detail) notFound();
  const { requisition, template } = detail;
  if (!can(user, "requisition.edit", requisition)) forbidden();
  const t = await getTranslations("Requisitions");
  const customFields = (requisition.customFieldsJson as Record<string, string | number | boolean | null>) ?? {};
  const options = await requisitionFormOptions({
    departmentId: requisition.departmentId,
    locationId: requisition.locationId,
    legalEntityId: requisition.legalEntityId,
    hiringManagerId: requisition.hiringManagerId,
    recruiterId: requisition.recruiterId,
    customFields,
    schema: template?.schema ?? [],
  });

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <Link href={`/requisitions/${requisition.id}`} className="text-sm underline">
        {t("back")}
      </Link>
      <h1 className="text-2xl font-semibold">{t("editTitle", { reqNumber: requisition.reqNumber })}</h1>
      {requisition.state !== "DRAFT" ? (
        <p role="alert">{t(requisition.state === "PENDING_APPROVAL" && !requisition.approvedAt ? "errors.awaitingApproval" : "errors.notEditable")}</p>
      ) : (
        <RequisitionForm
          options={options}
          existing={{ id: requisition.id, version: requisition.version, templateName: template?.name, schema: template?.schema ?? [] }}
          initial={{
            title: requisition.title,
            templateId: requisition.templateId,
            departmentId: requisition.departmentId,
            locationId: requisition.locationId,
            legalEntityId: requisition.legalEntityId,
            hiringManagerId: requisition.hiringManagerId,
            recruiterId: requisition.recruiterId,
            openingsCount: requisition.openingsCount,
            descriptionHtml: requisition.descriptionHtml,
            postingType: requisition.postingType,
            customFields,
          }}
        />
      )}
    </main>
  );
}
