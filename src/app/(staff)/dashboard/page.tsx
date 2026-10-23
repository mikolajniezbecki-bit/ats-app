// Staff home; later tasks add their content. The (staff) layout has already
// required a signed-in user.
import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requirePermission("staff.area");
  const t = await getTranslations("Dashboard");

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p data-testid="user-name">{t("signedInAs", { name: user.name })}</p>
      <p data-testid="user-role">{t("role", { role: user.role })}</p>
    </main>
  );
}
