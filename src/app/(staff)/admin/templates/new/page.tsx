// Create a template (ats-project-scope.md §5.1).
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { requirePermission } from "@/server/policy/guards";
import { TemplateForm } from "../template-form";

export const dynamic = "force-dynamic";

export default async function NewTemplatePage() {
  await requirePermission("templates.manage", undefined, "/admin/templates/new");
  const t = await getTranslations("AdminTemplates");

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <Link href="/admin/templates" className="text-sm underline">
        {t("back")}
      </Link>
      <h1 className="text-2xl font-semibold">{t("add")}</h1>
      <TemplateForm />
    </main>
  );
}
