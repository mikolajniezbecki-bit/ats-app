"use client";

// Offers on the application page (ats-project-scope.md §5.6, R10, L8, V4):
// newest first, older ones marked read-only. Admins and Recruiters create,
// edit and discard where the server says it is allowed; Hiring Managers in
// scope see the list only. The API checks everything again.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

export type PanelOffer = {
  id: string;
  version: number;
  jobTitle: string;
  salary: string;
  currency: string;
  startDate: string;
  templateId: string;
  templateName: string;
  approvalStatus: string;
  candidateResponse: string;
  createdBy: string;
  createdAt: string;
  frozen: boolean;
  editable: boolean;
  discardable: boolean;
};

type Props = {
  applicationId: string;
  offers: PanelOffer[];
  /** Null when the user can't create offers at all; otherwise the reason creation is blocked, or "" when allowed. */
  createBlock: string | null;
  templates: { id: string; name: string }[];
  currencies: readonly string[];
  defaults: { jobTitle: string; templateId: string; currency: string };
};
type ApiError = { message?: string; fields?: Record<string, string> };
type Mode = { kind: "create" } | { kind: "edit"; offer: PanelOffer } | { kind: "discard"; offer: PanelOffer } | null;

const amount = (value: string) => new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));

export function OffersPanel({ applicationId, offers, createBlock, templates, currencies, defaults }: Props) {
  const t = useTranslations("Offers");
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [errors, setErrors] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  async function send(url: string, method: string, body: unknown) {
    setPending(true);
    setErrors(null);
    const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setPending(false);
    if (response?.ok) {
      setMode(null);
      router.refresh();
      return;
    }
    setErrors(((await response?.json().catch(() => null)) as ApiError | null) ?? { message: t("failed") });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mode) return;
    if (mode.kind === "discard") {
      void send(`/api/offers/${mode.offer.id}/discard`, "POST", { version: mode.offer.version });
      return;
    }
    const form = new FormData(event.currentTarget);
    const fields = Object.fromEntries(["jobTitle", "salary", "currency", "startDate", "templateId"].map((name) => [name, String(form.get(name) ?? "")]));
    if (mode.kind === "create") void send(`/api/applications/${applicationId}/offers`, "POST", fields);
    else void send(`/api/offers/${mode.offer.id}`, "PATCH", { version: mode.offer.version, ...fields });
  }

  const open = (next: Mode) => {
    setErrors(null);
    setMode(next);
  };
  const fieldError = (name: string) =>
    errors?.fields?.[name] && (
      <p id={`offer-${name}-error`} role="alert" className="text-sm text-red-700">
        {errors.fields[name]}
      </p>
    );
  const invalid = (name: string) => (errors?.fields?.[name] ? { "aria-invalid": true, "aria-describedby": `offer-${name}-error` } : {});
  const editing = mode?.kind === "edit" ? mode.offer : null;
  const values = editing ?? { jobTitle: defaults.jobTitle, salary: "", currency: defaults.currency, startDate: "", templateId: defaults.templateId };
  // An edit keeps a stored template that was deactivated since (§5.1).
  const templateOptions = editing && !templates.some((template) => template.id === editing.templateId) ? [{ id: editing.templateId, name: editing.templateName }, ...templates] : templates;

  return (
    <div className="space-y-3">
      {offers.length === 0 ? (
        <p className="text-sm">{t("empty")}</p>
      ) : (
        <ul className="max-w-4xl space-y-2 text-sm">
          {offers.map((offer) => (
            <li key={offer.id} className="rounded border p-3" data-testid={`offer-${offer.id}`}>
              <p className="font-medium">
                {t("entry", { jobTitle: offer.jobTitle, salary: amount(offer.salary), currency: offer.currency, startDate: offer.startDate })}
                {offer.frozen && <span className="ml-2 rounded bg-neutral-200 px-2 py-0.5 text-xs">{t("frozen")}</span>}
              </p>
              <p>{t("template", { name: offer.templateName })}</p>
              <p>{t("approval", { status: t(`approvalStatuses.${offer.approvalStatus}`) })}</p>
              <p>{t("response", { response: t(`responses.${offer.candidateResponse}`) })}</p>
              <p className="text-neutral-700">
                {t("createdBy", { name: offer.createdBy })} · <time dateTime={offer.createdAt}>{offer.createdAt.slice(0, 16).replace("T", " ")} UTC</time>
              </p>
              {(offer.editable || offer.discardable) && (
                <div className="mt-2 flex gap-2">
                  {offer.editable && (
                    <button type="button" onClick={() => open({ kind: "edit", offer })} className="rounded border px-3 py-1">
                      {t("edit")}
                    </button>
                  )}
                  {offer.discardable && (
                    <button type="button" onClick={() => open({ kind: "discard", offer })} className="rounded border border-red-700 px-3 py-1 text-red-700">
                      {t("discard")}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {createBlock !== null && !mode && (
        <div className="space-y-1">
          <button
            type="button"
            disabled={createBlock !== ""}
            aria-describedby={createBlock ? "offer-create-block" : undefined}
            onClick={() => open({ kind: "create" })}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-60"
          >
            {t("create")}
          </button>
          {createBlock && (
            <p id="offer-create-block" className="text-sm text-neutral-700">
              {createBlock}
            </p>
          )}
        </div>
      )}
      {errors?.message && !mode && (
        <p role="alert" className="text-sm text-red-700">
          {errors.message}
        </p>
      )}

      {mode && (
        <form
          onSubmit={onSubmit}
          aria-label={mode.kind === "create" ? t("create") : mode.kind === "edit" ? t("edit") : t("discard")}
          className="max-w-xl space-y-3 rounded border p-4"
          noValidate
        >
          {mode.kind === "discard" ? (
            <p>{t("confirmDiscard")}</p>
          ) : (
            <>
              <div className="space-y-1">
                <label htmlFor="offer-jobTitle" className="block text-sm font-medium">
                  {t("fields.jobTitle")}
                </label>
                <input id="offer-jobTitle" name="jobTitle" required maxLength={200} defaultValue={values.jobTitle} {...invalid("jobTitle")} className="w-full rounded border px-3 py-2" />
                {fieldError("jobTitle")}
              </div>
              <div className="space-y-1">
                <label htmlFor="offer-salary" className="block text-sm font-medium">
                  {t("fields.salary")}
                </label>
                <input id="offer-salary" name="salary" inputMode="decimal" required defaultValue={values.salary} {...invalid("salary")} className="w-full rounded border px-3 py-2" />
                {fieldError("salary")}
              </div>
              <div className="space-y-1">
                <label htmlFor="offer-currency" className="block text-sm font-medium">
                  {t("fields.currency")}
                </label>
                <select id="offer-currency" name="currency" defaultValue={values.currency} {...invalid("currency")} className="w-full rounded border px-3 py-2">
                  {currencies.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
                {fieldError("currency")}
              </div>
              <div className="space-y-1">
                <label htmlFor="offer-startDate" className="block text-sm font-medium">
                  {t("fields.startDate")}
                </label>
                <input id="offer-startDate" name="startDate" type="date" required defaultValue={values.startDate} {...invalid("startDate")} className="w-full rounded border px-3 py-2" />
                {fieldError("startDate")}
              </div>
              <div className="space-y-1">
                <label htmlFor="offer-templateId" className="block text-sm font-medium">
                  {t("fields.templateId")}
                </label>
                <select id="offer-templateId" name="templateId" defaultValue={values.templateId} {...invalid("templateId")} className="w-full rounded border px-3 py-2">
                  <option value="">{t("fields.chooseTemplate")}</option>
                  {templateOptions.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
                {fieldError("templateId")}
              </div>
            </>
          )}
          {errors?.message && !errors.fields && (
            <p role="alert" className="text-sm text-red-700">
              {errors.message}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-60">
              {mode.kind === "create" ? t("create") : mode.kind === "edit" ? t("save") : t("confirm")}
            </button>
            <button type="button" onClick={() => setMode(null)} className="rounded border px-4 py-2">
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
