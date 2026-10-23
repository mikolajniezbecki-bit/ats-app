// Placeholder staff home until the back-office shell (task 12).
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { signInUrl } from "@/server/auth/redirect";
import { SessionKeepAlive } from "./session-keep-alive";
import { SignOutButton } from "./sign-out-button";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  // A present but stale, expired or inactive session (AU5, AU6).
  if (!user) redirect(signInUrl("/dashboard"));
  const t = await getTranslations("Dashboard");

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p data-testid="user-name">{t("signedInAs", { name: user.name })}</p>
      <p data-testid="user-role">{t("role", { role: user.role })}</p>
      <SignOutButton />
      <SessionKeepAlive />
    </main>
  );
}
