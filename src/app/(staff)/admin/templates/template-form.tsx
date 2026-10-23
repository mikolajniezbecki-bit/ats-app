"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { TOKEN_SCOPES } from "@/server/domain/tokens";
import { FIELD_TYPES, MAX_FIELDS, TRIGGER_STATUSES } from "@/server/templates/shared";

type TemplateType = "REQUISITION" | "EMAIL" | "OFFER";
type Field = { key: string; label: string; type: (typeof FIELD_TYPES)[number]; picklist_key?: string; required: boolean };
type Existing = {
  id: string;
  type: TemplateType;
  name: string;
  subject: string;
  body: string;
  triggerStatus: string;
  schemaJson: Field[];
  isActive: boolean;
};
type ApiError = { message?: string; fields?: Record<string, string> };

const tokenList = (tokens: readonly string[]) => tokens.map((token) => `[[${token}]]`).join(" ");

/**
 * Create or edit a template through /api/admin/templates. The fields follow
 * the type; type and name are fixed once created. The server validates
 * everything again (tokens, trigger conflicts, schema growth).
 */
export function TemplateForm({ existing }: { existing?: Existing }) {
  const t = useTranslations("AdminTemplates");
  const statuses = useTranslations("Statuses");
  const router = useRouter();
  const [type, setType] = useState<TemplateType>(existing?.type ?? "EMAIL");
  const [fields, setFields] = useState<Field[]>(existing?.schemaJson ?? []);
  const [errors, setErrors] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function send(method: string, url: string, body?: unknown) {
    setPending(true);
    setErrors(null);
    setStatus(null);
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => null);
    setPending(false);
    if (response?.ok) return (await response.json()) as { template: { id: string } };
    setErrors(((await response?.json().catch(() => null)) as ApiError | null) ?? { message: t("errors.failed") });
    return null;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "");
    const schemaJson = fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      ...(field.type === "PICKLIST" ? { picklist_key: field.picklist_key ?? "" } : {}),
    }));
    const content =
      type === "REQUISITION"
        ? { schemaJson }
        : type === "EMAIL"
          ? { subject: text("subject"), body: text("body"), triggerStatus: text("triggerStatus") || null }
          : { body: text("body") };
    const isActive = form.get("isActive") === "on";
    if (existing) {
      const result = await send("PATCH", `/api/admin/templates/${existing.id}`, { ...content, isActive });
      if (result) {
        setStatus(t("saved"));
        router.refresh();
      }
    } else {
      const result = await send("POST", "/api/admin/templates", { type, name: text("name"), ...content, isActive });
      if (result) router.push(`/admin/templates/${result.template.id}`);
    }
  }

  async function onDelete() {
    if (!existing) return;
    if (await send("DELETE", `/api/admin/templates/${existing.id}`)) router.push("/admin/templates");
  }

  const fieldError = (name: string) =>
    errors?.fields?.[name] && (
      <p id={`template-${name}-error`} role="alert" className="text-sm text-red-700">
        {errors.fields[name]}
      </p>
    );
  const invalid = (name: string) => (errors?.fields?.[name] ? { "aria-invalid": true, "aria-describedby": `template-${name}-error` } : {});
  const updateField = (index: number, change: Partial<Field>) =>
    setFields((current) => current.map((field, i) => (i === index ? { ...field, ...change } : field)));

  const bodyScope = type === "OFFER" ? TOKEN_SCOPES.offerBody : TOKEN_SCOPES.emailBody;

  return (
    <form onSubmit={onSubmit} aria-label={existing ? t("editTitle") : t("add")} className="flex max-w-3xl flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="template-type" className="block text-sm font-medium">
            {t("type")}
          </label>
          <select
            id="template-type"
            value={type}
            disabled={existing !== undefined}
            onChange={(event) => setType(event.target.value as TemplateType)}
            className="w-full rounded border px-3 py-2"
          >
            {(["EMAIL", "OFFER", "REQUISITION"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`typeNames.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="template-name" className="block text-sm font-medium">
            {t("name")}
          </label>
          <input
            id="template-name"
            name="name"
            defaultValue={existing?.name}
            readOnly={existing !== undefined}
            required
            maxLength={100}
            {...invalid("name")}
            className="w-full rounded border px-3 py-2 read-only:bg-neutral-100"
          />
          <p className="text-xs text-neutral-700">{t("nameHelp")}</p>
          {fieldError("name")}
        </div>
      </div>

      {type === "EMAIL" && (
        <>
          <div className="space-y-1">
            <label htmlFor="template-triggerStatus" className="block text-sm font-medium">
              {t("triggerStatus")}
            </label>
            <select id="template-triggerStatus" name="triggerStatus" defaultValue={existing?.triggerStatus ?? ""} {...invalid("triggerStatus")} className="w-full rounded border px-3 py-2">
              <option value="">{t("triggerNone")}</option>
              {TRIGGER_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statuses(value)}
                </option>
              ))}
            </select>
            {fieldError("triggerStatus")}
          </div>
          <div className="space-y-1">
            <label htmlFor="template-subject" className="block text-sm font-medium">
              {t("subject")}
            </label>
            <input id="template-subject" name="subject" defaultValue={existing?.subject} required maxLength={200} {...invalid("subject")} className="w-full rounded border px-3 py-2" />
            <p className="text-xs text-neutral-700">
              {t("subjectTokens")} <code>{tokenList(TOKEN_SCOPES.emailSubject)}</code>
            </p>
            {fieldError("subject")}
          </div>
        </>
      )}

      {type !== "REQUISITION" && (
        <div className="space-y-1">
          <label htmlFor="template-body" className="block text-sm font-medium">
            {t("body")}
          </label>
          <textarea
            id="template-body"
            name="body"
            defaultValue={existing?.body}
            required
            maxLength={20_000}
            rows={12}
            {...invalid("body")}
            aria-describedby={["template-body-help", errors?.fields?.body ? "template-body-error" : ""].filter(Boolean).join(" ")}
            className="w-full rounded border px-3 py-2 font-mono text-sm"
          />
          <div id="template-body-help" className="space-y-1 text-xs text-neutral-700">
            <p>{t("markupHelp")}</p>
            <p>
              {t("allowedTokens")} <code>{tokenList(bodyScope)}</code>
            </p>
          </div>
          {fieldError("body")}
        </div>
      )}

      {type === "REQUISITION" && (
        <fieldset className="space-y-3 rounded border p-4" aria-describedby={errors?.fields?.schemaJson ? "template-schemaJson-error" : undefined}>
          <legend className="px-1 font-semibold">{t("fields")}</legend>
          {fields.length === 0 && <p className="text-sm">{t("noFields")}</p>}
          {fields.map((field, index) => {
            const number = String(index + 1);
            const id = (part: string) => `field-${index}-${part}`;
            return (
              <div key={index} role="group" aria-label={t("fieldNumber", { number })} className="grid gap-2 border-b pb-3 sm:grid-cols-6">
                <div className="sm:col-span-1">
                  <label htmlFor={id("key")} className="block text-xs font-medium">
                    {t("fieldKey")}
                  </label>
                  <input id={id("key")} value={field.key} onChange={(event) => updateField(index, { key: event.target.value })} required className="w-full rounded border px-2 py-1 font-mono" />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor={id("label")} className="block text-xs font-medium">
                    {t("fieldLabel")}
                  </label>
                  <input id={id("label")} value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} required className="w-full rounded border px-2 py-1" />
                </div>
                <div>
                  <label htmlFor={id("type")} className="block text-xs font-medium">
                    {t("fieldType")}
                  </label>
                  <select id={id("type")} value={field.type} onChange={(event) => updateField(index, { type: event.target.value as Field["type"] })} className="w-full rounded border px-2 py-1">
                    {FIELD_TYPES.map((value) => (
                      <option key={value} value={value}>
                        {t(`fieldTypes.${value}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  {field.type === "PICKLIST" && (
                    <>
                      <label htmlFor={id("picklist")} className="block text-xs font-medium">
                        {t("fieldPicklistKey")}
                      </label>
                      <input id={id("picklist")} value={field.picklist_key ?? ""} onChange={(event) => updateField(index, { picklist_key: event.target.value })} required className="w-full rounded border px-2 py-1 font-mono" />
                    </>
                  )}
                </div>
                <div className="flex items-end gap-3">
                  <label className="flex items-center gap-1 text-xs font-medium">
                    <input type="checkbox" checked={field.required} onChange={(event) => updateField(index, { required: event.target.checked })} />
                    {t("fieldRequired")}
                  </label>
                  <button type="button" onClick={() => setFields((current) => current.filter((_, i) => i !== index))} className="rounded border px-2 py-1 text-xs">
                    {t("removeField", { number })}
                  </button>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            disabled={fields.length >= MAX_FIELDS}
            onClick={() => setFields((current) => [...current, { key: "", label: "", type: "TEXT", required: false }])}
            className="rounded border px-3 py-1"
          >
            {t("addField")}
          </button>
          {fieldError("schemaJson")}
        </fieldset>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isActive" defaultChecked={existing?.isActive ?? true} />
        {t("isActive")}
      </label>

      {errors?.message && !errors.fields && (
        <p role="alert" className="text-sm text-red-700">
          {errors.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-60">
          {t("save")}
        </button>
        {existing && (
          <button type="button" disabled={pending} onClick={onDelete} className="rounded border border-red-700 px-4 py-2 text-red-700">
            {t("delete")}
          </button>
        )}
        {status && (
          <p role="status" className="text-sm">
            {status}
          </p>
        )}
      </div>
    </form>
  );
}
