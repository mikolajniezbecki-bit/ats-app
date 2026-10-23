// Edit a template (ats-project-scope.md §5.1): type and name are fixed.
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/policy/guards";
import { type SchemaField, getTemplate } from "@/server/templates";
import { TemplateForm } from "../template-form";

export const dynamic = "force-dynamic";

export default async function EditTemplatePage({ params }: PageProps<"/admin/templates/[id]">) {
  const { id } = await params;
  await requirePermission("templates.manage", undefined, `/admin/templates/${encodeURIComponent(id)}`);
  const template = await getTemplate(id);
  if (!template) notFound();
  const t = await getTranslations("AdminTemplates");

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <Link href="/admin/templates" className="text-sm underline">
        {t("back")}
      </Link>
      <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>
      <TemplateForm
        existing={{
          id: template.id,
          type: template.type,
          name: template.name,
          subject: template.subject ?? "",
          body: template.body ?? "",
          triggerStatus: template.triggerStatus ?? "",
          schemaJson: (template.schemaJson as SchemaField[] | null) ?? [],
          isActive: template.isActive,
        }}
      />
    </main>
  );
}
