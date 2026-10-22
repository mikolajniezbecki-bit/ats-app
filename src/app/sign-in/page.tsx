import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { DEFAULT_SIGNED_IN_PATH, safeNextPath } from "@/server/auth/redirect";
import { getConfig } from "@/server/config";
import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  // A stale or expired cookie yields no user, so the form shows instead of a redirect loop.
  if (await getCurrentUser()) redirect(DEFAULT_SIGNED_IN_PATH);
  const { next } = await searchParams;
  const t = await getTranslations("SignIn");
  const devLogin = getConfig().auth.devLogin;

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        {devLogin ? (
          <SignInForm next={safeNextPath(typeof next === "string" ? next : undefined)} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
        )}
      </div>
    </main>
  );
}
