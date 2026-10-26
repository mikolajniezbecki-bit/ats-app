"use client";

// Approval actions on the requisition page (ats-project-scope.md A1, A3, A4, A9):
// the page decides which actions to show with the same policy checks the
// API runs; the API checks everything again.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

type Props = {
  requisitionId: string;
  version: number;
  approvers: { id: string; name: string }[] | null;
  /** A4: the reassignment picker, or null when the user can't reassign. */
  reassignApprovers: { id: string; name: string }[] | null;
  canDecide: boolean;
  canWithdraw: boolean;
};
type ApiError = { message?: string; fields?: Record<string, string> };
type Mode = "submit" | "approve" | "reject" | "withdraw" | "reassign" | null;

export function ApprovalActions({ requisitionId, version, approvers, reassignApprovers, canDecide, canWithdraw }: Props) {
  const t = useTranslations("Approvals.panel");
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [errors, setErrors] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  async function run(action: string, body: Record<string, unknown>) {
    setPending(true);
    setErrors(null);
    const response = await fetch(`/api/requisitions/${requisitionId}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version, ...body }),
    }).catch(() => null);
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
    const form = new FormData(event.currentTarget);
    const comment = String(form.get("comment") ?? "");
    if (mode === "submit") void run("submit", { approverId: String(form.get("approverId") ?? "") });
    else if (mode === "reassign") void run("reassign", { approverId: String(form.get("approverId") ?? ""), reason: String(form.get("reason") ?? "") });
    else if (mode) void run(mode, comment.trim() === "" && mode !== "reject" ? {} : { comment });
  }

  const fieldError = (name: string) =>
    errors?.fields?.[name] && (
      <p id={`approval-${name}-error`} role="alert" className="text-sm text-red-700">
        {errors.fields[name]}
      </p>
    );
  const invalid = (name: string) => (errors?.fields?.[name] ? { "aria-invalid": true, "aria-describedby": `approval-${name}-error` } : {});
  const open = (next: Mode) => {
    setErrors(null);
    setMode(next);
  };
  const otherErrors = errors?.fields ? Object.entries(errors.fields).filter(([key]) => key !== "approverId" && key !== "comment" && key !== "reason") : [];

  if (!approvers && !reassignApprovers && !canDecide && !canWithdraw) return null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {approvers && (
          <button type="button" onClick={() => open("submit")} className="rounded bg-black px-4 py-2 text-white">
            {t("submit")}
          </button>
        )}
        {canDecide && (
          <>
            <button type="button" onClick={() => open("approve")} className="rounded bg-black px-4 py-2 text-white">
              {t("approve")}
            </button>
            <button type="button" onClick={() => open("reject")} className="rounded border border-red-700 px-4 py-2 text-red-700">
              {t("reject")}
            </button>
          </>
        )}
        {canWithdraw && (
          <button type="button" onClick={() => open("withdraw")} className="rounded border px-4 py-2">
            {t("withdraw")}
          </button>
        )}
        {reassignApprovers && (
          <button type="button" onClick={() => open("reassign")} className="rounded border px-4 py-2">
            {t("reassign")}
          </button>
        )}
      </div>
      {mode && (
        <form onSubmit={onSubmit} aria-label={t(mode === "submit" ? "submit" : mode)} className="max-w-xl space-y-3 rounded border p-4" noValidate>
          {mode === "reassign" ? (
            <>
              <div className="space-y-1">
                <label htmlFor="approval-approverId" className="block text-sm font-medium">
                  {t("newApprover")}
                </label>
                <select id="approval-approverId" name="approverId" required defaultValue="" {...invalid("approverId")} className="w-full rounded border px-3 py-2">
                  <option value="">{t("chooseApprover")}</option>
                  {(reassignApprovers ?? []).map((approver) => (
                    <option key={approver.id} value={approver.id}>
                      {approver.name}
                    </option>
                  ))}
                </select>
                {fieldError("approverId")}
              </div>
              <div className="space-y-1">
                <label htmlFor="approval-reason" className="block text-sm font-medium">
                  {t("reason")}
                </label>
                <textarea id="approval-reason" name="reason" rows={3} required maxLength={2000} {...invalid("reason")} className="w-full rounded border px-3 py-2" />
                {fieldError("reason")}
              </div>
            </>
          ) : mode === "submit" ? (
            <div className="space-y-1">
              <label htmlFor="approval-approverId" className="block text-sm font-medium">
                {t("approver")}
              </label>
              <select id="approval-approverId" name="approverId" required defaultValue="" {...invalid("approverId")} className="w-full rounded border px-3 py-2">
                <option value="">{t("chooseApprover")}</option>
                {(approvers ?? []).map((approver) => (
                  <option key={approver.id} value={approver.id}>
                    {approver.name}
                  </option>
                ))}
              </select>
              {fieldError("approverId")}
            </div>
          ) : (
            <div className="space-y-1">
              <label htmlFor="approval-comment" className="block text-sm font-medium">
                {mode === "reject" ? t("comment") : t("commentOptional")}
              </label>
              <textarea id="approval-comment" name="comment" rows={3} maxLength={2000} {...invalid("comment")} className="w-full rounded border px-3 py-2" />
              {fieldError("comment")}
            </div>
          )}
          {otherErrors.length > 0 && (
            <ul role="alert" className="list-disc pl-5 text-sm text-red-700">
              {otherErrors.map(([key, text]) => (
                <li key={key}>{text}</li>
              ))}
            </ul>
          )}
          {errors?.message && !errors.fields && (
            <p role="alert" className="text-sm text-red-700">
              {errors.message}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-60">
              {mode === "submit" ? t("confirmSubmit") : mode === "reassign" ? t("confirmReassign") : t(mode)}
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
