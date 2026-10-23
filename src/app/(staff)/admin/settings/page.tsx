// Admin settings page (ats-project-scope.md §5.1): the effective value of
// every setting, "Default" where no Admin has set one. Saving goes through
// PUT /api/admin/settings.
import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/policy/guards";
import { listSettings } from "@/server/settings";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requirePermission("settings.manage", undefined, "/admin/settings");
  const t = await getTranslations("AdminSettings");
  const settings = await listSettings();

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <SettingsForm settings={settings.map((setting) => ({ ...setting, value: String(setting.value) }))} />
    </main>
  );
}
