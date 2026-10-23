// New requisition (ats-project-scope.md §5.2): blank, from a template
// (`?template=<id>`) or as a duplicate (`?from=<id>`, prefilled; nothing is
// written until the user saves). A duplicate of a requisition the caller
// can't see is 404.
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RequisitionForm } from "@/components/requisitions/requisition-form";
import { requirePermission } from "@/server/policy/guards";
import { duplicateValues, findVisibleRequisition } from "@/server/requisitions";
import { requisitionFormOptions } from "@/server/requisitions/form-options";

export const dynamic = "force-dynamic";

export default async function NewRequisitionPage({ searchParams }: PageProps<"/requisitions/new">) {
  const user = await requirePermission("requisition.create", undefined, "/requisitions/new");
  const params = await searchParams;
  const t = await getTranslations("Requisitions");
  const options = await requisitionFormOptions();

  let initial;
  let heading = t("newTitle");
  if (typeof params.from === "string") {
    const source = await duplicateValues(user, params.from);
    if (!source) notFound();
    heading = t("duplicateTitle", { reqNumber: (await findVisibleRequisition(user, params.from))!.reqNumber });
    // Only active templates are offered; a deactivated one isn't carried over.
    const templateId = options.templates.some((template) => template.id === source.templateId) ? source.templateId : null;
    initial = { ...source, templateId, customFields: templateId ? source.customFields : {} };
  } else if (typeof params.template === "string" && options.templates.some((template) => template.id === params.template)) {
    initial = { templateId: params.template };
  }

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <Link href="/requisitions" className="text-sm underline">
        {t("back")}
      </Link>
      <h1 className="text-2xl font-semibold">{heading}</h1>
      <RequisitionForm options={options} initial={initial} duplicateOfId={typeof params.from === "string" ? params.from : undefined} />
    </main>
  );
}
