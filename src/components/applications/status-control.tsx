"use client";

// The status control on the application page (ats-project-scope.md §5.4,
// R3, R4, R9): the server lists the targets the transition table allows now
// (on a HIRED application, an Admin's R4 corrections);
// the API checks everything again. A refusal or a stale version shows the
// API's message and keeps the typed comment.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

type Target = { status: string; needsComment: boolean };
type Props = { applicationId: string; version: number; targets: Target[]; statusLabels: Record<string, string>; correction?: boolean };

export function StatusControl({ applicationId, version, targets, statusLabels, correction = false }: Props) {
  const t = useTranslations("Applications.status");
  const router = useRouter();
  const [target, setTarget] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const needsComment = targets.find((option) => option.status === target)?.needsComment ?? false;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target) return;
    setPending(true);
    setError(null);
    setDone(null);
    const response = await fetch(`/api/applications/${applicationId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toStatus: target, version, ...(comment.trim() ? { comment } : {}) }),
    }).catch(() => null);
    setPending(false);
    if (response?.ok) {
      setDone(t("done", { status: statusLabels[target] ?? target }));
      setTarget("");
      setComment("");
      router.refresh();
      return;
    }
    const body = (await response?.json().catch(() => null)) as { message?: string } | null;
    setError(body?.message ?? t("failed"));
  }

  if (targets.length === 0) return <p className="text-sm">{t("none")}</p>;
  return (
    <form onSubmit={onSubmit} aria-label={correction ? t("correctTitle") : t("title")} className="max-w-xl space-y-3 rounded border p-4" noValidate>
      <div className="space-y-1">
        <label htmlFor="status-target" className="block text-sm font-medium">
          {t("target")}
        </label>
        <select id="status-target" name="toStatus" required value={target} onChange={(event) => setTarget(event.target.value)} className="w-full rounded border px-3 py-2">
          <option value="">{t("choose")}</option>
          {targets.map((option) => (
            <option key={option.status} value={option.status}>
              {option.needsComment && !correction ? t("reopen", { status: statusLabels[option.status] ?? option.status }) : (statusLabels[option.status] ?? option.status)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor="status-comment" className="block text-sm font-medium">
          {needsComment ? (correction ? t("correctionCommentRequired") : t("commentRequired")) : t("comment")}
        </label>
        <textarea
          id="status-comment"
          name="comment"
          rows={3}
          maxLength={2000}
          required={needsComment}
          aria-required={needsComment}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          className="w-full rounded border px-3 py-2"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="text-sm text-green-800">
          {done}
        </p>
      )}
      <button type="submit" disabled={pending || !target} className="rounded bg-black px-4 py-2 text-white disabled:opacity-60">
        {pending ? t("submitting") : correction ? t("correctSubmit") : t("submit")}
      </button>
    </form>
  );
}
