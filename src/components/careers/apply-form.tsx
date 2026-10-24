"use client";

// Quick Apply form (ats-project-scope.md §5.3, F2): the fields, the active
// questions and the privacy consent. The browser checks the file size as a
// convenience; the server action decides. Submitting with onSubmit (not a
// form action) keeps the entered values and chosen files after a refusal.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, useState, useTransition } from "react";
import { type ApplyState, applyAction } from "@/app/(public)/apply/actions";
import type { FormQuestion } from "@/server/apply";
import { TurnstileWidget } from "./turnstile-widget";

type Props = {
  route: { kind: "external" | "private"; key: string };
  questions: FormQuestion[];
  privacy: { version: string; text: string };
  maxMb: number;
  turnstile: { siteKey: string; nonce?: string };
};

const BYTES_PER_MB = 1_048_576;

export function ApplyForm({ route, questions: initialQuestions, privacy: initialPrivacy, maxMb, turnstile }: Props) {
  const t = useTranslations("Apply");
  const router = useRouter();
  const [questions, setQuestions] = useState(initialQuestions);
  const [privacy, setPrivacy] = useState(initialPrivacy);
  const [state, setState] = useState<Extract<ApplyState, { status: "error" }> | null>(null);
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  // Bumped after every refusal, so the single-use Turnstile token is renewed.
  const [attempt, setAttempt] = useState(0);

  function checkFile(event: ChangeEvent<HTMLInputElement>) {
    const { name, files } = event.target;
    const chosen = files?.[0];
    let error = "";
    if (chosen && chosen.size === 0) error = t("errors.fileEmpty");
    else if (chosen && chosen.size > maxMb * BYTES_PER_MB) error = t("errors.fileTooLarge", { max: String(maxMb) });
    setFileErrors((current) => ({ ...current, [name]: error }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (Object.values(fileErrors).some(Boolean)) return;
    const data = new FormData(event.currentTarget);
    // An input with no file chosen sends an empty, unnamed file; it means "no file".
    for (const name of ["cv", "coverLetter"]) {
      const value = data.get(name);
      if (value instanceof File && value.size === 0 && value.name === "") data.delete(name);
    }
    startTransition(async () => {
      let result: ApplyState;
      try {
        result = await applyAction(data);
      } catch {
        setState({ status: "error", message: t("errors.uploadTooLarge"), fields: {} });
        setAttempt((value) => value + 1);
        return;
      }
      if (result.status === "ok") {
        router.push("/apply/thanks");
        return;
      }
      if (result.refresh) {
        setQuestions(result.refresh.questions);
        setPrivacy(result.refresh.privacy);
      }
      setState(result);
      setAttempt((value) => value + 1);
    });
  }

  const errorFor = (name: string) => fileErrors[name] || state?.fields[name];
  const errorId = (name: string) => `apply-${name.replace(".", "-")}-error`;
  const fieldError = (name: string) =>
    errorFor(name) ? (
      <p id={errorId(name)} className="text-sm text-red-800">
        {errorFor(name)}
      </p>
    ) : null;
  const invalid = (name: string) => (errorFor(name) ? { "aria-invalid": true, "aria-describedby": errorId(name) } : {});
  const input = "w-full rounded border border-neutral-500 bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-neutral-900";
  const textField = (name: string, type = "text", autoComplete?: string, maxLength?: number) => (
    <div className="space-y-1">
      <label htmlFor={`apply-${name}`} className="block font-medium">
        {t(`fields.${name}`)}
      </label>
      <input id={`apply-${name}`} name={name} type={type} autoComplete={autoComplete} maxLength={maxLength} required {...invalid(name)} className={input} />
      {fieldError(name)}
    </div>
  );

  return (
    <form onSubmit={onSubmit} aria-label={t("formLabel")} className="space-y-6" noValidate>
      <input type="hidden" name="routeKind" value={route.kind} />
      <input type="hidden" name="routeKey" value={route.key} />
      <input type="hidden" name="consentVersion" value={privacy.version} />
      <input type="hidden" name="questionStamp" value={JSON.stringify(questions.map((question) => ({ id: question.id, updatedAt: question.updatedAt })))} />

      {state && (
        <div role="alert" className="rounded border border-red-800 bg-red-50 px-4 py-3 text-red-900">
          {state.message}
        </div>
      )}

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-xl font-semibold">{t("contact")}</legend>
        {textField("firstName", "text", "given-name", 100)}
        {textField("lastName", "text", "family-name", 100)}
        {textField("email", "email", "email", 254)}
        {textField("phone", "tel", "tel", 30)}
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-xl font-semibold">{t("documents")}</legend>
        {(["cv", "coverLetter"] as const).map((name) => (
          <div key={name} className="space-y-1">
            <label htmlFor={`apply-${name}`} className="block font-medium">
              {t(`fields.${name}`)}
            </label>
            <input
              id={`apply-${name}`}
              name={name}
              type="file"
              accept="application/pdf,.pdf"
              required={name === "cv"}
              onChange={checkFile}
              {...invalid(name)}
              aria-describedby={[errorFor(name) ? errorId(name) : "", "apply-files-help"].filter(Boolean).join(" ")}
              className="block w-full text-sm file:mr-4 file:rounded file:border file:border-neutral-500 file:bg-white file:px-3 file:py-2"
            />
            {fieldError(name)}
          </div>
        ))}
        <p id="apply-files-help" className="text-sm text-neutral-700">
          {t("filesHelp", { max: String(maxMb) })}
        </p>
      </fieldset>

      {questions.length > 0 && (
        <fieldset className="space-y-4">
          <legend className="mb-2 text-xl font-semibold">{t("questions")}</legend>
          {questions.map((question) => {
            const name = `answers.${question.id}`;
            const required = question.type === "YES_NO" || question.type === "SINGLE";
            if (question.type === "TEXT") {
              return (
                <div key={question.id} className="space-y-1">
                  <label htmlFor={`apply-q-${question.id}`} className="block font-medium">
                    {question.text} <span className="font-normal text-neutral-700">{t("optional")}</span>
                  </label>
                  <textarea id={`apply-q-${question.id}`} name={`q_${question.id}`} rows={3} maxLength={2000} {...invalid(name)} className={input} />
                  {fieldError(name)}
                </div>
              );
            }
            return (
              <fieldset key={question.id} className="space-y-1" {...invalid(name)}>
                <legend className="font-medium">
                  {question.text} {!required && <span className="font-normal text-neutral-700">{t("optional")}</span>}
                </legend>
                {question.options.map((option) => (
                  <label key={option.code} className="flex items-center gap-2">
                    <input type={question.type === "MULTI" ? "checkbox" : "radio"} name={`q_${question.id}`} value={option.code} required={required} />
                    {option.label}
                  </label>
                ))}
                {fieldError(name)}
              </fieldset>
            );
          })}
        </fieldset>
      )}

      <fieldset className="space-y-3">
        <legend className="mb-2 text-xl font-semibold">{t("privacyTitle")}</legend>
        <div
          tabIndex={0}
          role="region"
          aria-label={t("privacyRegion", { version: privacy.version })}
          className="max-h-48 overflow-y-auto whitespace-pre-line rounded border border-neutral-500 p-3 text-sm focus-visible:outline-2 focus-visible:outline-neutral-900"
        >
          {privacy.text}
        </div>
        <label className="flex items-start gap-2">
          <input type="checkbox" name="consent" required {...invalid("consent")} className="mt-1" />
          <span>{t("consent", { version: privacy.version })}</span>
        </label>
        {fieldError("consent")}
      </fieldset>

      {/* Honeypot (F6): off-screen, skipped by the keyboard and screen readers; people leave it empty. */}
      <div aria-hidden="true" className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="apply-website">{t("honeypot")}</label>
        <input id="apply-website" name="website" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" defaultValue="" />
      </div>

      <TurnstileWidget siteKey={turnstile.siteKey} nonce={turnstile.nonce} resetKey={attempt} label={t("verification")} />

      <button type="submit" disabled={pending} className="rounded bg-neutral-900 px-6 py-3 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:opacity-60">
        {pending ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
