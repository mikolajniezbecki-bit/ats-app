"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

type Props = { next: string };

/** AU7 dev sign-in: posts to Better Auth's email endpoint, then loads `next`. */
export function SignInForm({ next }: Props) {
  const t = useTranslations("SignIn");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const response = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    }).catch(() => null);
    if (response?.ok) {
      // A full load, so the server renders the next page with the new cookie.
      window.location.assign(next);
      return;
    }
    const body = (await response?.json().catch(() => null)) as { code?: string } | null;
    setPending(false);
    if (body?.code === "ACCESS_NOT_GRANTED") setError(t("accessNotGranted"));
    else if (response?.status === 401 || body?.code === "INVALID_EMAIL_OR_PASSWORD") setError(t("invalidCredentials"));
    else setError(t("failed"));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <p className="text-sm text-muted-foreground">{t("devOnly")}</p>
      <div className="space-y-1">
        <label htmlFor="email" className="block text-sm font-medium">
          {t("email")}
        </label>
        <input id="email" name="email" type="email" autoComplete="username" required className="w-full rounded border px-3 py-2" />
      </div>
      <div className="space-y-1">
        <label htmlFor="password" className="block text-sm font-medium">
          {t("password")}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="w-full rounded border px-3 py-2"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending} className="w-full rounded bg-black px-3 py-2 text-white disabled:opacity-60">
        {pending ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
