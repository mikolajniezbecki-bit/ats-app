"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

type ApiError = { message?: string; fields?: Record<string, string> };

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: ApiError }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  if (response?.ok) return { ok: true };
  return { ok: false, error: ((await response?.json().catch(() => null)) as ApiError | null) ?? {} };
}

/** Creates a record through POST /api/admin/master-data. */
export function CreateMasterDataForm() {
  const t = useTranslations("AdminMasterData");
  const router = useRouter();
  const [type, setType] = useState("DEPARTMENT");
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending(true);
    setError(null);
    const result = await send("/api/admin/master-data", "POST", {
      type,
      code: form.get("code"),
      label: form.get("label"),
      ...(type === "PICKLIST" ? { picklistKey: form.get("picklistKey") } : {}),
    });
    setPending(false);
    if (result.ok) {
      formElement.reset();
      router.refresh();
    } else {
      setError(result.error?.message ? result.error : { message: t("errors.failed") });
    }
  }

  const fieldError = (field: string) =>
    error?.fields?.[field] && (
      <p id={`create-${field}-error`} role="alert" className="text-sm text-red-700">
        {error.fields[field]}
      </p>
    );

  return (
    <form onSubmit={onSubmit} aria-labelledby="create-heading" className="flex max-w-3xl flex-col gap-3 rounded border p-4">
      <h2 id="create-heading" className="font-semibold">
        {t("add")}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="create-type" className="block text-sm font-medium">
            {t("type")}
          </label>
          <select id="create-type" value={type} onChange={(event) => setType(event.target.value)} className="w-full rounded border px-3 py-2">
            {(["DEPARTMENT", "LOCATION", "LEGAL_ENTITY", "PICKLIST"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`types.${value}`)}
              </option>
            ))}
          </select>
        </div>
        {type === "PICKLIST" && (
          <div className="space-y-1">
            <label htmlFor="create-picklistKey" className="block text-sm font-medium">
              {t("picklistKey")}
            </label>
            <input id="create-picklistKey" name="picklistKey" required pattern="[a-z0-9_]{1,50}" aria-describedby="create-picklistKey-help" className="w-full rounded border px-3 py-2" />
            <p id="create-picklistKey-help" className="text-xs text-neutral-700">
              {t("picklistKeyHelp")}
            </p>
            {fieldError("picklistKey")}
          </div>
        )}
        <div className="space-y-1">
          <label htmlFor="create-code" className="block text-sm font-medium">
            {t("code")}
          </label>
          <input id="create-code" name="code" required maxLength={50} aria-describedby="create-code-help" className="w-full rounded border px-3 py-2 font-mono" />
          <p id="create-code-help" className="text-xs text-neutral-700">
            {t("codeHelp")}
          </p>
          {fieldError("code")}
        </div>
        <div className="space-y-1">
          <label htmlFor="create-label" className="block text-sm font-medium">
            {t("label")}
          </label>
          <input id="create-label" name="label" required maxLength={200} className="w-full rounded border px-3 py-2" />
          {fieldError("label")}
        </div>
      </div>
      {error?.message && !error.fields && (
        <p role="alert" className="text-sm text-red-700">
          {error.message}
        </p>
      )}
      <button type="submit" disabled={pending} className="self-start rounded bg-black px-4 py-2 text-white disabled:opacity-60">
        {t("create")}
      </button>
    </form>
  );
}

/** Rename, deactivate or reactivate, and delete one record. */
export function MasterDataRowActions({ id, label, isActive }: { id: string; label: string; isActive: boolean }) {
  const t = useTranslations("AdminMasterData");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(method: "PATCH" | "DELETE", body?: unknown) {
    setPending(true);
    setError(null);
    const result = await send(`/api/admin/master-data/${id}`, method, body);
    setPending(false);
    if (result.ok) router.refresh();
    else setError(Object.values(result.error?.fields ?? {})[0] ?? result.error?.message ?? t("errors.failed"));
  }

  async function onRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("PATCH", { label: new FormData(event.currentTarget).get("label") });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={onRename} className="flex items-center gap-1">
          <label htmlFor={`label-${id}`} className="sr-only">
            {t("label")}
          </label>
          <input id={`label-${id}`} key={label} name="label" defaultValue={label} required maxLength={200} className="rounded border px-2 py-1" />
          <button type="submit" disabled={pending} className="rounded border px-2 py-1">
            {t("rename")}
          </button>
        </form>
        <button type="button" disabled={pending} onClick={() => run("PATCH", { isActive: !isActive })} className="rounded border px-2 py-1">
          {isActive ? t("deactivate") : t("reactivate")}
        </button>
        <button type="button" disabled={pending} onClick={() => run("DELETE")} className="rounded border border-red-700 px-2 py-1 text-red-700">
          {t("delete")}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
