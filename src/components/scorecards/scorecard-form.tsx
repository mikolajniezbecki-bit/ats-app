"use client";

// The caller's scorecard (ats-project-scope.md I9, V8): thumbs, rating 1–5,
// comments and optional PDF notes, saved as a draft or submitted. Native
// radio buttons and a select, so it works with the keyboard alone. A
// submitted scorecard is read-only. The API checks everything again.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, useState } from "react";
import { pdfFileProblem } from "@/components/pdf-file-check";

type Scorecard = { thumbsUp: boolean; overallRating: number; comments: string | null; submittedAt: string | null; reopenedAt: string | null };
type Props = {
  interviewId: string;
  scorecard: Scorecard | null;
  notesFileId: string | null;
  maxMb: number;
  /** Why the caller can't write now (the API's text), or null. */
  refusal: string | null;
};
type ApiError = { message?: string; fields?: Record<string, string> };

export function ScorecardForm({ interviewId, scorecard, notesFileId, maxMb, refusal }: Props) {
  const t = useTranslations("Scorecards");
  const router = useRouter();
  const [errors, setErrors] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const readOnly = scorecard?.submittedAt !== null && scorecard?.submittedAt !== undefined;
  const disabled = readOnly || refusal !== null;

  async function send(url: string, init: RequestInit, done?: string) {
    setPending(true);
    setErrors(null);
    setStatus(null);
    const response = await fetch(url, init).catch(() => null);
    setPending(false);
    if (response?.ok) {
      if (done) setStatus(done);
      router.refresh();
      return;
    }
    setErrors(((await response?.json().catch(() => null)) as ApiError | null) ?? { message: t("failed") });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const form = new FormData(event.currentTarget);
    const thumbs = form.get("thumbs");
    const rating = Number(form.get("overallRating") ?? "");
    const body = {
      ...(thumbs === null ? {} : { thumbsUp: thumbs === "up" }),
      ...(rating ? { overallRating: rating } : {}),
      comments: String(form.get("comments") ?? ""),
    };
    const submit = submitter?.value === "submit";
    void send(
      `/api/interviews/${interviewId}/scorecard${submit ? "/submit" : ""}`,
      { method: submit ? "POST" : "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      submit ? undefined : t("saved"),
    );
  }

  function checkNotes(event: ChangeEvent<HTMLInputElement>) {
    const problem = pdfFileProblem(event.target.files?.[0], maxMb);
    setFileError(problem === "empty" ? t("fileEmpty") : problem === "tooLarge" ? t("fileTooLarge", { max: String(maxMb) }) : null);
  }

  function uploadNotes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("notes") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || pdfFileProblem(file, maxMb)) return;
    const data = new FormData();
    data.set("notes", file);
    void send(`/api/interviews/${interviewId}/scorecard/notes`, { method: "PUT", body: data });
  }

  const fieldError = (name: string) =>
    errors?.fields?.[name] && (
      <p id={`scorecard-${name}-error`} role="alert" className="text-sm text-red-700">
        {errors.fields[name]}
      </p>
    );
  const invalid = (name: string) => (errors?.fields?.[name] ? { "aria-invalid": true, "aria-describedby": `scorecard-${name}-error` } : {});

  return (
    <div className="max-w-xl space-y-4">
      {refusal && (
        <p role="status" className="rounded border border-amber-700 bg-amber-50 px-3 py-2 text-amber-900">
          {refusal}
        </p>
      )}
      {!refusal && readOnly && <p role="status">{t("readOnly")}</p>}
      {!readOnly && scorecard?.reopenedAt && <p role="status">{t("reopened")}</p>}
      <form onSubmit={onSubmit} aria-label={t("title")} className="space-y-4 rounded border p-4" noValidate>
        <fieldset className="space-y-1" disabled={disabled} {...invalid("thumbsUp")}>
          <legend className="text-sm font-medium">{t("thumbs")}</legend>
          <label className="mr-4 inline-flex items-center gap-2">
            <input type="radio" name="thumbs" value="up" defaultChecked={scorecard?.thumbsUp === true} /> {t("thumbsUp")}
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" name="thumbs" value="down" defaultChecked={scorecard?.thumbsUp === false} /> {t("thumbsDown")}
          </label>
          {fieldError("thumbsUp")}
        </fieldset>
        <div className="space-y-1">
          <label htmlFor="scorecard-rating" className="block text-sm font-medium">
            {t("rating")}
          </label>
          <select id="scorecard-rating" name="overallRating" disabled={disabled} defaultValue={scorecard?.overallRating ?? ""} {...invalid("overallRating")} className="w-full rounded border px-3 py-2">
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((rating) => (
              <option key={rating} value={rating}>
                {t("ratingOption", { rating })}
              </option>
            ))}
          </select>
          {fieldError("overallRating")}
        </div>
        <div className="space-y-1">
          <label htmlFor="scorecard-comments" className="block text-sm font-medium">
            {t("comments")}
          </label>
          <textarea
            id="scorecard-comments"
            name="comments"
            rows={6}
            maxLength={5000}
            disabled={disabled}
            defaultValue={scorecard?.comments ?? ""}
            {...invalid("comments")}
            className="w-full rounded border px-3 py-2"
          />
          {fieldError("comments")}
        </div>
        {errors?.message && !errors.fields && (
          <p role="alert" className="text-sm text-red-700">
            {errors.message}
          </p>
        )}
        {status && <p role="status">{status}</p>}
        {!disabled && (
          <div className="flex gap-2">
            <button type="submit" name="action" value="draft" disabled={pending} className="rounded border px-4 py-2">
              {t("saveDraft")}
            </button>
            <button type="submit" name="action" value="submit" disabled={pending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-60">
              {t("submit")}
            </button>
          </div>
        )}
      </form>

      <section aria-labelledby="notes-heading" className="space-y-2 rounded border p-4">
        <h2 id="notes-heading" className="font-medium">
          {t("notes")}
        </h2>
        {notesFileId && (
          <p className="text-sm">
            <a href={`/files/${notesFileId}`} className="underline" target="_blank" rel="noreferrer">
              {t("currentNotes")}
            </a>
          </p>
        )}
        {!disabled && scorecard && (
          <>
            <form onSubmit={uploadNotes} aria-label={t("uploadNotes")} className="space-y-2">
              <label htmlFor="scorecard-notes" className="block text-sm">
                {t("notesHelp", { max: String(maxMb) })}
              </label>
              <input id="scorecard-notes" name="notes" type="file" accept="application/pdf" onChange={checkNotes} aria-invalid={fileError || errors?.fields?.notes ? true : undefined} />
              {(fileError || errors?.fields?.notes) && (
                <p role="alert" className="text-sm text-red-700">
                  {fileError ?? errors?.fields?.notes}
                </p>
              )}
              <button type="submit" disabled={pending} className="rounded border px-4 py-2">
                {t("uploadNotes")}
              </button>
            </form>
            {notesFileId && (
              <button type="button" disabled={pending} onClick={() => void send(`/api/interviews/${interviewId}/scorecard/notes`, { method: "DELETE" })} className="rounded border px-4 py-2">
                {t("removeNotes")}
              </button>
            )}
          </>
        )}
        {!disabled && !scorecard && <p className="text-sm">{t("notesHelp", { max: String(maxMb) })}</p>}
      </section>
    </div>
  );
}
