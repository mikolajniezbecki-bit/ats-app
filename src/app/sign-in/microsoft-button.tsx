"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

type Props = { next: string };

/**
 * AU1 Entra sign-in: asks Better Auth for Microsoft's authorization URL and
 * goes there. A refused sign-in comes back to /sign-in?error=<code> (AU2).
 */
export function MicrosoftButton({ next }: Props) {
  const t = useTranslations("SignIn");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setPending(true);
    setFailed(false);
    const response = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "microsoft", callbackURL: next }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { url?: string } | null;
    if (response?.ok && body?.url) {
      window.location.assign(body.url);
      return;
    }
    setPending(false);
    setFailed(true);
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={signIn}
        disabled={pending}
        className="w-full rounded bg-black px-3 py-2 text-white disabled:opacity-60"
      >
        {pending ? t("redirecting") : t("microsoft")}
      </button>
      {failed && (
        <p role="alert" className="text-sm text-red-700">
          {t("failed")}
        </p>
      )}
    </div>
  );
}
