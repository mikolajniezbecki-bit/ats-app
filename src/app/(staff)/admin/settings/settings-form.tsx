"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

type Setting = {
  key: string;
  value: string;
  isDefault: boolean;
  // The server's definition (src/server/settings): the form mirrors its
  // limits; the server validates again and is the authority.
  input: { kind: "integer"; min: number; max: number } | { kind: "email" } | { kind: "text" | "multiline"; max: number };
};

const HELP: Record<string, "timingHelp" | "privacyHelp"> = {
  REJECTION_EMAIL_DELAY_HOURS: "timingHelp",
  APPROVAL_REMINDER_DAYS: "timingHelp",
  PRIVACY_STATEMENT_TEXT: "privacyHelp",
};

/** Sends only the changed values to PUT /api/admin/settings and shows the server's field errors. */
export function SettingsForm({ settings }: { settings: Setting[] }) {
  const t = useTranslations("AdminSettings");
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const changes = Object.fromEntries(
      settings.filter((s) => String(form.get(s.key) ?? "") !== s.value).map((s) => [s.key, String(form.get(s.key) ?? "")]),
    );
    setErrors({});
    if (Object.keys(changes).length === 0) {
      setStatus(t("noChanges"));
      return;
    }
    setPending(true);
    setStatus(null);
    const response = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    }).catch(() => null);
    setPending(false);
    if (response?.ok) {
      setStatus(t("saved"));
      router.refresh();
      return;
    }
    const body = (await response?.json().catch(() => null)) as { fields?: Record<string, string> } | null;
    if (body?.fields) setErrors(body.fields);
    else setStatus(t("failed"));
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-5">
      {settings.map((setting) => {
        const input = setting.input;
        const id = `setting-${setting.key}`;
        const error = errors[setting.key];
        const help = HELP[setting.key];
        const describedBy = [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
        const common = {
          id,
          name: setting.key,
          defaultValue: setting.value,
          required: true,
          "aria-invalid": error ? true : undefined,
          "aria-describedby": describedBy,
          className: "w-full rounded border px-3 py-2",
        };
        return (
          <div key={setting.key} className="space-y-1" data-testid={`setting-${setting.key}`}>
            <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium">
              {t(`labels.${setting.key}`)}
              {setting.isDefault && <span className="rounded bg-neutral-200 px-1.5 text-xs text-neutral-800">{t("default")}</span>}
            </label>
            {input.kind === "multiline" ? (
              <textarea key={setting.value} {...common} rows={8} maxLength={input.max} />
            ) : input.kind === "integer" ? (
              <input key={setting.value} {...common} type="number" min={input.min} max={input.max} step={1} />
            ) : input.kind === "email" ? (
              <input key={setting.value} {...common} type="email" />
            ) : (
              <input key={setting.value} {...common} type="text" maxLength={input.max} />
            )}
            {help && (
              <p id={`${id}-help`} className="text-xs text-neutral-700">
                {t(help)}
              </p>
            )}
            {error && (
              <p id={`${id}-error`} role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
          </div>
        );
      })}
      {errors._ && (
        <p role="alert" className="text-sm text-red-700">
          {errors._}
        </p>
      )}
      <div className="flex items-center gap-4">
        <button type="submit" disabled={pending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-60">
          {pending ? t("saving") : t("save")}
        </button>
        {status && (
          <p role="status" className="text-sm">
            {status}
          </p>
        )}
      </div>
    </form>
  );
}
