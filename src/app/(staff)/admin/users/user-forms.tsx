"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

type RoleOption = { value: string; label: string };
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

/** Creates a user through POST /api/admin/users. There is no password: staff sign in with Entra ID. */
export function CreateUserForm({ roles }: { roles: RoleOption[] }) {
  const t = useTranslations("AdminUsers");
  const router = useRouter();
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending(true);
    setError(null);
    const result = await send("/api/admin/users", "POST", { email: form.get("email"), name: form.get("name"), role: form.get("role") });
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
      <p role="alert" className="text-sm text-red-700">
        {error.fields[field]}
      </p>
    );

  return (
    <form onSubmit={onSubmit} aria-labelledby="create-user-heading" className="flex max-w-3xl flex-col gap-3 rounded border p-4">
      <h2 id="create-user-heading" className="font-semibold">
        {t("add")}
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label htmlFor="create-email" className="block text-sm font-medium">
            {t("email")}
          </label>
          <input id="create-email" name="email" type="email" required className="w-full rounded border px-3 py-2" />
          {fieldError("email")}
        </div>
        <div className="space-y-1">
          <label htmlFor="create-name" className="block text-sm font-medium">
            {t("name")}
          </label>
          <input id="create-name" name="name" required maxLength={200} className="w-full rounded border px-3 py-2" />
          {fieldError("name")}
        </div>
        <div className="space-y-1">
          <label htmlFor="create-role" className="block text-sm font-medium">
            {t("role")}
          </label>
          <select id="create-role" name="role" required defaultValue="RECRUITER" className="w-full rounded border px-3 py-2">
            {roles.map((role) => (
              <option key={role.value} value={role.value}>
                {role.label}
              </option>
            ))}
          </select>
          {fieldError("role")}
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

type RowUser = { id: string; name: string; role: string; isActive: boolean };

/** Name, role and active flag of one user. */
export function UserRowActions({ user, roles }: { user: RowUser; roles: RoleOption[] }) {
  const t = useTranslations("AdminUsers");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(url: string, method: string, body?: unknown) {
    setPending(true);
    setError(null);
    const result = await send(url, method, body);
    setPending(false);
    if (result.ok) router.refresh();
    else setError(Object.values(result.error?.fields ?? {})[0] ?? result.error?.message ?? t("errors.failed"));
  }

  const onName = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    return run(`/api/admin/users/${user.id}`, "PATCH", { name: new FormData(event.currentTarget).get("name") });
  };
  const onRole = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    return run(`/api/admin/users/${user.id}`, "PATCH", { role: new FormData(event.currentTarget).get("role") });
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={onName} className="flex items-center gap-1">
          <label htmlFor={`name-${user.id}`} className="sr-only">
            {t("name")}
          </label>
          <input id={`name-${user.id}`} key={user.name} name="name" defaultValue={user.name} required maxLength={200} className="rounded border px-2 py-1" />
          <button type="submit" disabled={pending} className="rounded border px-2 py-1">
            {t("saveName")}
          </button>
        </form>
        <form onSubmit={onRole} className="flex items-center gap-1">
          <label htmlFor={`role-${user.id}`} className="sr-only">
            {t("role")}
          </label>
          <select id={`role-${user.id}`} key={user.role} name="role" defaultValue={user.role} className="rounded border px-2 py-1">
            {roles.map((role) => (
              <option key={role.value} value={role.value}>
                {role.label}
              </option>
            ))}
          </select>
          <button type="submit" disabled={pending} className="rounded border px-2 py-1">
            {t("changeRole")}
          </button>
        </form>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(`/api/admin/users/${user.id}/${user.isActive ? "deactivate" : "reactivate"}`, "POST")}
          className="rounded border px-2 py-1"
        >
          {user.isActive ? t("deactivate") : t("reactivate")}
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
