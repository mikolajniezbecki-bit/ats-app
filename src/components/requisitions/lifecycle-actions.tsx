"use client";

// Lifecycle actions on the requisition page (ats-project-scope.md §5.2 L4–L7,
// L9): the page lists the actions this user may take in the current state;
// the API checks everything again. Close and reopen need a comment; the
// close form says what will happen first.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

type Action = "hold" | "resume" | "close" | "reopen" | "unpublish" | "republish";
type Props = { requisitionId: string; version: number; actions: Action[]; closeImpact: { applications: number; offers: number } | null };
type ApiError = { message?: string; fields?: Record<string, string> };

const COMMENT: Record<Action, "required" | "optional" | "none"> = {
  hold: "optional",
  resume: "optional",
  close: "required",
  reopen: "required",
  unpublish: "none",
  republish: "none",
};

export function LifecycleActions({ requisitionId, version, actions, closeImpact }: Props) {
  const t = useTranslations("Requisitions.lifecycle");
  const router = useRouter();
  const [mode, setMode] = useState<Action | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mode) return;
    setPending(true);
    setError(null);
    const body = COMMENT[mode] === "none" ? { version } : { version, ...(comment.trim() ? { comment } : {}) };
    const response = await fetch(`/api/requisitions/${requisitionId}/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setPending(false);
    if (response?.ok) {
      setMode(null);
      setComment("");
      router.refresh();
      return;
    }
    setError(((await response?.json().catch(() => null)) as ApiError | null) ?? { message: t("failed") });
  }

  if (actions.length === 0) return null;
  const commentRule = mode ? COMMENT[mode] : "none";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            onClick={() => {
              setMode(action);
              setError(null);
            }}
            className={action === "close" ? "rounded border border-red-700 px-4 py-2 text-red-700" : "rounded border px-4 py-2"}
          >
            {t(`actions.${action}`)}
          </button>
        ))}
      </div>
      {mode && (
        <form onSubmit={onSubmit} aria-label={t(`actions.${mode}`)} className="max-w-xl space-y-3 rounded border p-4" noValidate>
          <p>{t(`confirm.${mode}`)}</p>
          {mode === "close" && closeImpact && <p className="font-medium">{t("closeImpact", { applications: closeImpact.applications, offers: closeImpact.offers })}</p>}
          {commentRule !== "none" && (
            <div className="space-y-1">
              <label htmlFor="lifecycle-comment" className="block text-sm font-medium">
                {commentRule === "required" ? t("commentRequired") : t("commentOptional")}
              </label>
              <textarea
                id="lifecycle-comment"
                rows={3}
                maxLength={2000}
                required={commentRule === "required"}
                aria-required={commentRule === "required"}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                className="w-full rounded border px-3 py-2"
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error.fields ? Object.values(error.fields).join(" ") : error.message}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-60">
              {t(`actions.${mode}`)}
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
