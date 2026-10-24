"use client";

// Create or edit a requisition through /api/requisitions (ats-project-scope.md
// §5.2). The form only collects values; the server checks references, custom
// fields and the description again and returns per-field errors.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import type { CustomFieldDefinition } from "@/server/domain/requisitions/custom-fields";
import type { FormOption, FormOptions } from "@/server/requisitions/form-options";
import { DescriptionEditor } from "./description-editor";

export type FormValues = {
  title: string;
  templateId: string | null;
  departmentId: string;
  locationId: string;
  legalEntityId: string;
  hiringManagerId: string;
  recruiterId: string;
  openingsCount: number;
  descriptionHtml: string;
  postingType: "EXTERNAL" | "PRIVATE";
  customFields: Record<string, string | number | boolean | null>;
};

type Props = {
  options: FormOptions;
  initial?: Partial<FormValues>;
  /** Editing: the requisition, its version and its fixed template's schema. */
  existing?: { id: string; version: number; templateName?: string; schema: CustomFieldDefinition[] };
  /** Creating a duplicate: the source, whose active questions are copied on save. */
  duplicateOfId?: string;
  /** Fields shown read-only, e.g. the L2 fields outside APPROVED (L1, L2); they are still sent unchanged. */
  locked?: readonly string[];
  /** An APPROVED requisition (L2): the approvers offered when a change needs re-approval. */
  reApprovalApprovers?: { id: string; name: string }[];
};
type ApiError = { message?: string; fields?: Record<string, string> };

export function RequisitionForm({ options, initial, existing, duplicateOfId, locked = [], reApprovalApprovers }: Props) {
  const t = useTranslations("Requisitions");
  const router = useRouter();
  const [values, setValues] = useState<FormValues>({
    title: initial?.title ?? "",
    templateId: initial?.templateId ?? null,
    departmentId: initial?.departmentId ?? "",
    locationId: initial?.locationId ?? "",
    legalEntityId: initial?.legalEntityId ?? "",
    hiringManagerId: initial?.hiringManagerId ?? "",
    recruiterId: initial?.recruiterId ?? "",
    openingsCount: initial?.openingsCount ?? 1,
    descriptionHtml: initial?.descriptionHtml ?? "",
    postingType: initial?.postingType ?? "EXTERNAL",
    customFields: initial?.customFields ?? {},
  });
  const [errors, setErrors] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [approverId, setApproverId] = useState("");
  // L2: a higher openings count or another department, hiring manager or legal entity needs re-approval.
  const needsReApproval =
    reApprovalApprovers !== undefined &&
    initial !== undefined &&
    ((Number.isInteger(values.openingsCount) && values.openingsCount > (initial.openingsCount ?? 0)) ||
      values.departmentId !== initial.departmentId ||
      values.hiringManagerId !== initial.hiringManagerId ||
      values.legalEntityId !== initial.legalEntityId);

  const schema = existing ? existing.schema : (options.templates.find((template) => template.id === values.templateId)?.schema ?? []);
  const set = (change: Partial<FormValues>) => setValues((current) => ({ ...current, ...change }));
  const setCustom = (key: string, value: string | number | boolean | null) =>
    setValues((current) => ({ ...current, customFields: { ...current.customFields, [key]: value } }));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setErrors(null);
    const customFields = Object.fromEntries(schema.map((field) => [field.key, values.customFields[field.key] ?? null]));
    const content = {
      title: values.title,
      departmentId: values.departmentId,
      locationId: values.locationId,
      legalEntityId: values.legalEntityId,
      hiringManagerId: values.hiringManagerId,
      recruiterId: values.recruiterId,
      openingsCount: Number.isInteger(values.openingsCount) ? values.openingsCount : -1,
      descriptionHtml: values.descriptionHtml,
      postingType: values.postingType,
      customFields,
    };
    const response = await fetch(existing ? `/api/requisitions/${existing.id}` : "/api/requisitions", {
      method: existing ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(existing ? { version: existing.version, ...content, ...(needsReApproval ? { approverId } : {}) } : { templateId: values.templateId, ...(duplicateOfId ? { duplicateOfId } : {}), ...content }),
    }).catch(() => null);
    setPending(false);
    if (response?.ok) {
      const { requisition } = (await response.json()) as { requisition: { id: string } };
      router.push(`/requisitions/${requisition.id}`);
      router.refresh();
      return;
    }
    setErrors(((await response?.json().catch(() => null)) as ApiError | null) ?? { message: t("errors.failed") });
  }

  const errorId = (name: string) => `requisition-${name.replace(".", "-")}-error`;
  const fieldError = (name: string) =>
    errors?.fields?.[name] && (
      <p id={errorId(name)} role="alert" className="text-sm text-red-700">
        {errors.fields[name]}
      </p>
    );
  const invalid = (name: string) => (errors?.fields?.[name] ? { "aria-invalid": true, "aria-describedby": errorId(name) } : {});
  const label = (option: FormOption) => (option.inactive ? t("inactive", { label: option.label }) : option.label);

  const select = (name: keyof FormValues, labelText: string, list: FormOption[]) => (
    <div className="space-y-1">
      <label htmlFor={`requisition-${name}`} className="block text-sm font-medium">
        {labelText}
      </label>
      <select
        id={`requisition-${name}`}
        value={String(values[name] ?? "")}
        onChange={(event) => set({ [name]: event.target.value })}
        required
        disabled={locked.includes(name)}
        {...invalid(name)}
        className="w-full rounded border px-3 py-2"
      >
        <option value="">{t("fields.select")}</option>
        {list.map((option) => (
          <option key={option.id} value={option.id}>
            {label(option)}
          </option>
        ))}
      </select>
      {fieldError(name)}
    </div>
  );

  function customInput(field: CustomFieldDefinition) {
    const name = `customFields.${field.key}`;
    const id = `requisition-custom-${field.key}`;
    const value = values.customFields[field.key] ?? null;
    const common = { id, required: field.required, ...invalid(name), className: "w-full rounded border px-3 py-2" };
    let input;
    if (field.type === "PICKLIST") {
      input = (
        <select {...common} value={typeof value === "string" ? value : ""} onChange={(event) => setCustom(field.key, event.target.value || null)}>
          <option value="">{t("fields.select")}</option>
          {(options.picklists[field.picklist_key ?? ""] ?? []).map((option) => (
            <option key={option.code} value={option.code}>
              {option.inactive ? t("inactive", { label: option.label }) : option.label}
            </option>
          ))}
        </select>
      );
    } else if (field.type === "BOOLEAN") {
      input = (
        <select
          {...common}
          value={value === null ? "" : String(value)}
          onChange={(event) => setCustom(field.key, event.target.value === "" ? null : event.target.value === "true")}
        >
          <option value="">{t("fields.notSet")}</option>
          <option value="true">{t("fields.yes")}</option>
          <option value="false">{t("fields.no")}</option>
        </select>
      );
    } else if (field.type === "NUMBER") {
      input = (
        <input
          {...common}
          type="number"
          step="any"
          value={typeof value === "number" ? value : ""}
          onChange={(event) => setCustom(field.key, event.target.value === "" ? null : Number(event.target.value))}
        />
      );
    } else {
      input = <input {...common} maxLength={1000} value={typeof value === "string" ? value : ""} onChange={(event) => setCustom(field.key, event.target.value || null)} />;
    }
    return (
      <div key={field.key} className="space-y-1">
        <label htmlFor={id} className="block text-sm font-medium">
          {field.label}
        </label>
        {input}
        {fieldError(name)}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} aria-label={existing ? t("save") : t("newTitle")} className="flex max-w-3xl flex-col gap-4" noValidate>
      <div className="space-y-1">
        <label htmlFor="requisition-templateId" className="block text-sm font-medium">
          {t("fields.template")}
        </label>
        {existing ? (
          <>
            <input id="requisition-templateId" readOnly value={existing.templateName ?? t("fields.blank")} className="w-full rounded border bg-neutral-100 px-3 py-2" />
            <p className="text-xs text-neutral-700">{t("fields.templateFixed")}</p>
          </>
        ) : (
          <select
            id="requisition-templateId"
            value={values.templateId ?? ""}
            onChange={(event) => set({ templateId: event.target.value || null, customFields: {} })}
            {...invalid("templateId")}
            className="w-full rounded border px-3 py-2"
          >
            <option value="">{t("fields.blank")}</option>
            {options.templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        )}
        {fieldError("templateId")}
      </div>

      <div className="space-y-1">
        <label htmlFor="requisition-title" className="block text-sm font-medium">
          {t("fields.title")}
        </label>
        <input
          id="requisition-title"
          value={values.title}
          onChange={(event) => set({ title: event.target.value })}
          required
          maxLength={200}
          {...invalid("title")}
          className="w-full rounded border px-3 py-2"
        />
        {fieldError("title")}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {select("departmentId", t("fields.department"), options.departments)}
        {select("locationId", t("fields.location"), options.locations)}
        {select("legalEntityId", t("fields.legalEntity"), options.legalEntities)}
        {select("hiringManagerId", t("fields.hiringManager"), options.hiringManagers)}
        {select("recruiterId", t("fields.recruiter"), options.recruiters)}
        <div className="space-y-1">
          <label htmlFor="requisition-openingsCount" className="block text-sm font-medium">
            {t("fields.openingsCount")}
          </label>
          <input
            id="requisition-openingsCount"
            type="number"
            min={1}
            max={1000}
            step={1}
            value={Number.isNaN(values.openingsCount) ? "" : values.openingsCount}
            onChange={(event) => set({ openingsCount: event.target.valueAsNumber })}
            required
            disabled={locked.includes("openingsCount")}
            {...invalid("openingsCount")}
            className="w-full rounded border px-3 py-2"
          />
          {fieldError("openingsCount")}
        </div>
        <div className="space-y-1">
          <label htmlFor="requisition-postingType" className="block text-sm font-medium">
            {t("fields.postingType")}
          </label>
          <select
            id="requisition-postingType"
            value={values.postingType}
            onChange={(event) => set({ postingType: event.target.value as FormValues["postingType"] })}
            {...invalid("postingType")}
            className="w-full rounded border px-3 py-2"
          >
            <option value="EXTERNAL">{t("postingTypes.EXTERNAL")}</option>
            <option value="PRIVATE">{t("postingTypes.PRIVATE")}</option>
          </select>
          {fieldError("postingType")}
        </div>
      </div>

      <div className="space-y-1">
        <span id="requisition-description-label" className="block text-sm font-medium">
          {t("fields.description")}
        </span>
        <DescriptionEditor
          id="requisition-description"
          labelId="requisition-description-label"
          describedBy={errors?.fields?.descriptionHtml ? errorId("descriptionHtml") : undefined}
          initialHtml={values.descriptionHtml}
          onChange={(html) => set({ descriptionHtml: html })}
        />
        {fieldError("descriptionHtml")}
      </div>

      {schema.length > 0 && (
        <fieldset className="space-y-3 rounded border p-4">
          <legend className="px-1 font-semibold">{t("fields.customFields")}</legend>
          {schema.map(customInput)}
        </fieldset>
      )}

      {errors?.message && (!errors.fields || Object.keys(errors.fields).length === 0) && (
        <p role="alert" className="text-sm text-red-700">
          {errors.message}
        </p>
      )}
      {errors?.fields && Object.keys(errors.fields).some((key) => !key.startsWith("customFields.") && !(key in values)) && (
        <p role="alert" className="text-sm text-red-700">
          {Object.entries(errors.fields)
            .filter(([key]) => !key.startsWith("customFields.") && !(key in values))
            .map(([, text]) => text)
            .join(" ")}
        </p>
      )}
      {needsReApproval && (
        <div className="space-y-1 rounded border border-amber-700 bg-amber-50 p-3" data-testid="reapproval-picker">
          <p className="text-sm text-amber-900">{t("reapprovalNote")}</p>
          <label htmlFor="requisition-approverId" className="block text-sm font-medium">
            {t("reapprovalApprover")}
          </label>
          <select
            id="requisition-approverId"
            value={approverId}
            onChange={(event) => setApproverId(event.target.value)}
            required
            {...invalid("approverId")}
            className="w-full rounded border px-3 py-2"
          >
            <option value="">{t("fields.select")}</option>
            {(reApprovalApprovers ?? []).map((approver) => (
              <option key={approver.id} value={approver.id}>
                {approver.name}
              </option>
            ))}
          </select>
          {fieldError("approverId")}
        </div>
      )}
      <div>
        <button type="submit" disabled={pending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-60">
          {t("save")}
        </button>
      </div>
    </form>
  );
}
