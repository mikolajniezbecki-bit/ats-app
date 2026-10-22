"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

/** Deletes the session row and the cookie, then goes to sign-in. */
export function SignOutButton() {
  const t = useTranslations("Dashboard");
  const router = useRouter();

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST" }).catch(() => null);
    router.replace("/sign-in");
    router.refresh();
  }

  return (
    <button type="button" onClick={signOut} className="w-fit rounded border px-3 py-2">
      {t("signOut")}
    </button>
  );
}
