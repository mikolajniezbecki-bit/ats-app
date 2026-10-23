// Admin overview (§3): later tasks link their Admin pages from here.
// Other roles get the 403 page with HTTP 403, not just a hidden link (T5).
import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  await requirePermission("admin.area", undefined, "/admin");
  const t = await getTranslations("Admin");

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
    </main>
  );
}
