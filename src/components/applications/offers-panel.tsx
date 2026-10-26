"use client";

// Offers on the application page (ats-project-scope.md §5.6, R10, L8, V4,
// A1–A9): newest first, older ones marked read-only. Admins and Recruiters
// create, edit, discard, submit, withdraw and reassign where the server says
// it is allowed; the current approver approves or rejects; others read. The
// API checks everything again.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { LocalTime } from "@/components/local-time";

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
  needsReapproval: boolean;
  discardable: boolean;
  submittable: boolean;
  decidable: boolean;
  withdrawable: boolean;
  reassignable: boolean;
  approverId: string | null;
  submittedByUserId: string | null;
  approver: string | null;
  submitter: string | null;
  submittedAt: string | null;
  latestEvent: { event: string; actor: string | null; comment: string | null; createdAt: string } | null;
};

type Props = {
  applicationId: string;
  offers: PanelOffer[];
  /** Null when the user can't create offers at all; otherwise the reason creation is blocked, or "" when allowed. */
  createBlock: string | null;
  templates: { id: string; name: string }[];
  currencies: readonly string[];
  defaults: { jobTitle: string; templateId: string; currency: string };
  /** Active Hiring Managers and Admins; the pickers leave out who can't approve. */
  approvers: { id: string; name: string }[];
  currentUserId: string;
};
type ApiError = { message?: string; fields?: Record<string, string> };
type Action = "edit" | "discard" | "submit" | "approve" | "reject" | "withdraw" | "reassign";
type Mode = { kind: "create" } | { kind: Action; offer: PanelOffer } | null;

const amount = (value: string) => new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));

export function OffersPanel({ applicationId, offers, createBlock, templates, currencies, defaults, approvers, currentUserId }: Props) {
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
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "");
    if (mode.kind !== "create" && mode.kind !== "edit") {
      const { offer } = mode;
      const bodies: Record<Exclude<Action, "edit">, Record<string, unknown>> = {
        discard: {},
        submit: { approverId: text("approverId") },
        approve: text("comment").trim() ? { comment: text("comment") } : {},
        reject: { comment: text("comment") },
        withdraw: text("comment").trim() ? { comment: text("comment") } : {},
        reassign: { approverId: text("approverId"), reason: text("reason") },
      };
      void send(`/api/offers/${offer.id}/${mode.kind}`, "POST", { version: offer.version, ...bodies[mode.kind] });
      return;
    }
    const fields = Object.fromEntries(["jobTitle", "salary", "currency", "startDate", "templateId"].map((name) => [name, String(form.get(name) ?? "")]));
    if (mode.kind === "create") void send(`/api/applications/${applicationId}/offers`, "POST", fields);
    else void send(`/api/offers/${mode.offer.id}`, "PATCH", { version: mode.offer.version, ...fields, ...(mode.offer.needsReapproval ? { approverId: text("approverId") } : {}) });
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
  // A2: never the caller (submit, re-approval); A4: never the submitter or the current approver.
  const approverOptions = (exclude: (string | null)[]) => approvers.filter((approver) => !exclude.includes(approver.id));
  const approverSelect = (options: { id: string; name: string }[]) => (
    <div className="space-y-1">
      <label htmlFor="offer-approverId" className="block text-sm font-medium">
        {t("fields.approver")}
      </label>
      <select id="offer-approverId" name="approverId" defaultValue="" {...invalid("approverId")} className="w-full rounded border px-3 py-2">
        <option value="">{t("fields.chooseApprover")}</option>
        {options.map((approver) => (
          <option key={approver.id} value={approver.id}>
            {approver.name}
          </option>
        ))}
      </select>
      {fieldError("approverId")}
    </div>
  );
  const textarea = (name: "comment" | "reason", label: string) => (
    <div className="space-y-1">
      <label htmlFor={`offer-${name}`} className="block text-sm font-medium">
        {label}
      </label>
      <textarea id={`offer-${name}`} name={name} rows={3} maxLength={2000} {...invalid(name)} className="w-full rounded border px-3 py-2" />
      {fieldError(name)}
    </div>
  );
  const labels: Record<Action, string> = {
    edit: t("edit"),
    discard: t("discard"),
    submit: t("submit"),
    approve: t("approve"),
    reject: t("reject"),
    withdraw: t("withdraw"),
    reassign: t("reassign"),
  };
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
                {t("createdBy", { name: offer.createdBy })} · <LocalTime value={offer.createdAt} />
              </p>
              {offer.approvalStatus === "PENDING" && offer.submittedAt && (
                <p data-testid={`offer-approval-${offer.id}`}>
                  {t("awaiting", { approver: offer.approver ?? "—", submitter: offer.submitter ?? "—" })} <LocalTime value={offer.submittedAt} />
                </p>
              )}
              {offer.latestEvent && offer.latestEvent.event !== "SUBMITTED" && (
                <p data-testid={`offer-latest-${offer.id}`}>
                  {t("latest", { event: t(`events.${offer.latestEvent.event}`), actor: offer.latestEvent.actor ?? t("system") })} <LocalTime value={offer.latestEvent.createdAt} />
                  {offer.latestEvent.comment && <span className="block whitespace-pre-wrap">{t("latestComment", { comment: offer.latestEvent.comment })}</span>}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {(["submit", "approve", "reject", "withdraw", "reassign", "edit", "discard"] as const)
                  .filter((action) =>
                    action === "submit"
                      ? offer.submittable
                      : action === "approve" || action === "reject"
                        ? offer.decidable
                        : action === "withdraw"
                          ? offer.withdrawable
                          : action === "reassign"
                            ? offer.reassignable
                            : action === "edit"
                              ? offer.editable
                              : offer.discardable,
                  )
                  .map((action) => (
                    <button
                      key={action}
                      type="button"
                      onClick={() => open({ kind: action, offer })}
                      className={action === "discard" || action === "reject" ? "rounded border border-red-700 px-3 py-1 text-red-700" : "rounded border px-3 py-1"}
                    >
                      {labels[action]}
                    </button>
                  ))}
              </div>
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
          aria-label={mode.kind === "create" ? t("create") : labels[mode.kind]}
          className="max-w-xl space-y-3 rounded border p-4"
          noValidate
        >
          {mode.kind === "discard" ? (
            <p>{t("confirmDiscard")}</p>
          ) : mode.kind === "submit" ? (
            approverSelect(approverOptions([currentUserId]))
          ) : mode.kind === "approve" || mode.kind === "withdraw" ? (
            textarea("comment", t("fields.commentOptional"))
          ) : mode.kind === "reject" ? (
            textarea("comment", t("fields.comment"))
          ) : mode.kind === "reassign" ? (
            <>
              {approverSelect(approverOptions([mode.offer.submittedByUserId, mode.offer.approverId]))}
              {textarea("reason", t("fields.reason"))}
            </>
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
              {editing?.needsReapproval && (
                <>
                  <p className="text-sm">{t("reapprovalNote")}</p>
                  {approverSelect(approverOptions([currentUserId]))}
                </>
              )}
            </>
          )}
          {errors?.message && !errors.fields && (
            <p role="alert" className="text-sm text-red-700">
              {errors.message}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-60">
              {mode.kind === "create" ? t("create") : mode.kind === "edit" ? t("save") : mode.kind === "discard" ? t("confirm") : labels[mode.kind]}
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
