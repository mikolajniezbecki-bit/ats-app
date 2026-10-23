"use client";

// Pre-screening question editor on the requisition page (ats-project-scope.md
// §5.3, L3): add, edit, delete, deactivate and reorder through
// /api/requisitions/[id]/questions. The server checks every rule again.
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import type { QuestionAnswerKey, QuestionOption, QuestionType } from "@/server/domain/prescreen/questions";

export type EditorQuestion = {
  id: string;
  questionText: string;
  questionType: QuestionType;
  options: QuestionOption[];
  weight: number;
  scoringAnswer: QuestionAnswerKey;
  disqualifyingAnswer: QuestionAnswerKey;
  isActive: boolean;
};

type ApiError = { message?: string; fields?: Record<string, string> };
const TYPES: QuestionType[] = ["YES_NO", "SINGLE", "MULTI", "TEXT"];

export function PrescreenEditor({ requisitionId, questions, canEdit }: { requisitionId: string; questions: EditorQuestion[]; canEdit: boolean }) {
  const t = useTranslations("Prescreen");
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const base = `/api/requisitions/${requisitionId}/questions`;

  async function send(method: string, url: string, body?: unknown): Promise<ApiError | null> {
    setPending(true);
    setError(null);
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => null);
    setPending(false);
    if (response?.ok) {
      router.refresh();
      return null;
    }
    return ((await response?.json().catch(() => null)) as ApiError | null) ?? { message: t("errors.failed") };
  }

  async function act(method: string, url: string, body?: unknown) {
    const failure = await send(method, url, body);
    if (failure) setError(failure.message ?? t("errors.failed"));
  }

  function move(index: number, delta: number) {
    const ids = questions.map((question) => question.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved);
    void act("PUT", `${base}/order`, { questionIds: ids });
  }

  const answerText = (question: EditorQuestion, value: QuestionAnswerKey) => {
    const codes = Array.isArray(value) ? value : value === null ? [] : [value];
    return codes.map((code) => question.options.find((option) => option.code === code)?.label ?? code).join(", ");
  };

  return (
    <section aria-labelledby="prescreen-heading" className="max-w-3xl space-y-3">
      <h2 id="prescreen-heading" className="text-xl font-semibold">
        {t("title")}
      </h2>
      <p className="text-sm text-neutral-700">{t("description")}</p>
      {questions.length === 0 && <p>{t("empty")}</p>}
      <ol className="space-y-2">
        {questions.map((question, index) => {
          const number = String(index + 1);
          return (
            <li key={question.id} aria-label={t("questionNumber", { number })} className="rounded border p-3" data-testid="prescreen-question">
              {editing === question.id ? (
                <QuestionForm
                  initial={question}
                  title={t("editTitle", { number })}
                  pending={pending}
                  onCancel={() => setEditing(null)}
                  onSubmit={async (body) => {
                    const failure = await send("PATCH", `${base}/${question.id}`, body);
                    if (!failure) setEditing(null);
                    return failure;
                  }}
                />
              ) : (
                <div className="space-y-1">
                  <p className="font-medium">
                    {number}. {question.questionText} {!question.isActive && <span className="ml-2 rounded bg-neutral-200 px-2 text-xs">{t("inactive")}</span>}
                  </p>
                  <p className="text-sm text-neutral-700">{t("summary", { type: t(`types.${question.questionType}`), weight: String(question.weight) })}</p>
                  {question.scoringAnswer !== null && <p className="text-sm">{t("scoring", { answer: answerText(question, question.scoringAnswer) })}</p>}
                  {question.disqualifyingAnswer !== null && (
                    <p className="text-sm">{t("disqualifying", { answer: answerText(question, question.disqualifyingAnswer) })}</p>
                  )}
                  {canEdit && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <button type="button" className="rounded border px-2 py-1 text-sm" onClick={() => setEditing(question.id)} disabled={pending}>
                        {t("edit")}
                      </button>
                      <button
                        type="button"
                        className="rounded border px-2 py-1 text-sm"
                        disabled={pending}
                        onClick={() => act("PATCH", `${base}/${question.id}`, { isActive: !question.isActive })}
                      >
                        {question.isActive ? t("deactivate") : t("reactivate")}
                      </button>
                      <button type="button" className="rounded border border-red-700 px-2 py-1 text-sm text-red-700" disabled={pending} onClick={() => act("DELETE", `${base}/${question.id}`)}>
                        {t("delete")}
                      </button>
                      <button type="button" className="rounded border px-2 py-1 text-sm" disabled={pending || index === 0} aria-label={t("moveUp", { number })} onClick={() => move(index, -1)}>
                        ↑
                      </button>
                      <button
                        type="button"
                        className="rounded border px-2 py-1 text-sm"
                        disabled={pending || index === questions.length - 1}
                        aria-label={t("moveDown", { number })}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {canEdit &&
        (editing === "new" ? (
          <div className="rounded border p-3">
            <QuestionForm
              title={t("addTitle")}
              pending={pending}
              onCancel={() => setEditing(null)}
              onSubmit={async (body) => {
                const failure = await send("POST", base, body);
                if (!failure) setEditing(null);
                return failure;
              }}
            />
          </div>
        ) : (
          <button type="button" className="rounded bg-black px-4 py-2 text-white" onClick={() => setEditing("new")}>
            {t("add")}
          </button>
        ))}
    </section>
  );
}

type FormProps = {
  initial?: EditorQuestion;
  title: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<ApiError | null>;
};

function QuestionForm({ initial, title, pending, onCancel, onSubmit }: FormProps) {
  const t = useTranslations("Prescreen");
  const [type, setType] = useState<QuestionType>(initial?.questionType ?? "YES_NO");
  const [text, setText] = useState(initial?.questionText ?? "");
  const [options, setOptions] = useState<QuestionOption[]>(
    initial && (initial.questionType === "SINGLE" || initial.questionType === "MULTI")
      ? initial.options
      : [
          { code: "", label: "" },
          { code: "", label: "" },
        ],
  );
  const [weight, setWeight] = useState(initial?.weight ?? 0);
  const [scoring, setScoring] = useState<QuestionAnswerKey>(initial?.scoringAnswer ?? null);
  const [disqualifying, setDisqualifying] = useState<QuestionAnswerKey>(initial?.disqualifyingAnswer ?? null);
  const [errors, setErrors] = useState<ApiError | null>(null);
  const prefix = initial ? `question-${initial.id}` : "question-new";

  const choices: QuestionOption[] =
    type === "YES_NO"
      ? [
          { code: "YES", label: t("fields.yes") },
          { code: "NO", label: t("fields.no") },
        ]
      : options.filter((option) => option.code !== "");

  function changeType(next: QuestionType) {
    setType(next);
    setScoring(null);
    setDisqualifying(null);
    if (next === "TEXT") setWeight(0);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body: Record<string, unknown> = {
      questionText: text,
      questionType: type,
      weight: type === "TEXT" ? 0 : Number.isNaN(weight) ? -1 : weight,
      scoringAnswer: type === "TEXT" ? null : scoring,
      disqualifyingAnswer: type === "TEXT" ? null : disqualifying,
    };
    if (type === "SINGLE" || type === "MULTI") body.options = options;
    else body.options = [];
    if (type === "YES_NO") delete body.options;
    const failure = await onSubmit(body);
    setErrors(failure);
  }

  const id = (name: string) => `${prefix}-${name}`;
  const fieldError = (name: string) =>
    errors?.fields?.[name] && (
      <p id={id(`${name}-error`)} role="alert" className="text-sm text-red-700">
        {errors.fields[name]}
      </p>
    );
  const invalid = (name: string) => (errors?.fields?.[name] ? { "aria-invalid": true, "aria-describedby": id(`${name}-error`) } : {});

  const answerInput = (name: "scoringAnswer" | "disqualifyingAnswer", value: QuestionAnswerKey, set: (value: QuestionAnswerKey) => void) =>
    type === "MULTI" ? (
      <fieldset className="space-y-1" {...invalid(name)}>
        <legend className="text-sm font-medium">{t(`fields.${name}`)}</legend>
        {choices.map((choice) => {
          const selected = Array.isArray(value) ? value : [];
          return (
            <label key={choice.code} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(choice.code)}
                onChange={(event) => {
                  const next = event.target.checked ? [...selected, choice.code] : selected.filter((code) => code !== choice.code);
                  set(next.length > 0 ? next : null);
                }}
              />
              {choice.label || choice.code}
            </label>
          );
        })}
        {fieldError(name)}
      </fieldset>
    ) : (
      <div className="space-y-1">
        <label htmlFor={id(name)} className="block text-sm font-medium">
          {t(`fields.${name}`)}
        </label>
        <select id={id(name)} value={typeof value === "string" ? value : ""} onChange={(event) => set(event.target.value || null)} {...invalid(name)} className="w-full rounded border px-3 py-2">
          <option value="">{t("fields.none")}</option>
          {choices.map((choice) => (
            <option key={choice.code} value={choice.code}>
              {choice.label || choice.code}
            </option>
          ))}
        </select>
        {fieldError(name)}
      </div>
    );

  return (
    <form onSubmit={submit} aria-label={title} className="space-y-3" noValidate>
      <h3 className="font-semibold">{title}</h3>
      <div className="space-y-1">
        <label htmlFor={id("text")} className="block text-sm font-medium">
          {t("fields.questionText")}
        </label>
        <input id={id("text")} value={text} onChange={(event) => setText(event.target.value)} maxLength={500} required {...invalid("questionText")} className="w-full rounded border px-3 py-2" />
        {fieldError("questionText")}
      </div>
      <div className="space-y-1">
        <label htmlFor={id("type")} className="block text-sm font-medium">
          {t("fields.questionType")}
        </label>
        <select id={id("type")} value={type} onChange={(event) => changeType(event.target.value as QuestionType)} {...invalid("questionType")} className="w-full rounded border px-3 py-2">
          {TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`types.${value}`)}
            </option>
          ))}
        </select>
        {fieldError("questionType")}
      </div>
      {(type === "SINGLE" || type === "MULTI") && (
        <fieldset className="space-y-2" {...invalid("options")}>
          <legend className="text-sm font-medium">{t("fields.options")}</legend>
          {options.map((option, index) => {
            const number = String(index + 1);
            const update = (change: Partial<QuestionOption>) => setOptions((current) => current.map((o, i) => (i === index ? { ...o, ...change } : o)));
            return (
              <div key={index} role="group" aria-label={`${t("fields.options")} ${number}`} className="flex flex-wrap items-end gap-2">
                <div>
                  <label htmlFor={id(`option-${index}-code`)} className="block text-xs font-medium">
                    {t("fields.optionCode")}
                  </label>
                  <input id={id(`option-${index}-code`)} value={option.code} onChange={(event) => update({ code: event.target.value.toUpperCase() })} maxLength={30} className="rounded border px-2 py-1 font-mono" />
                </div>
                <div className="flex-1">
                  <label htmlFor={id(`option-${index}-label`)} className="block text-xs font-medium">
                    {t("fields.optionLabel")}
                  </label>
                  <input id={id(`option-${index}-label`)} value={option.label} onChange={(event) => update({ label: event.target.value })} maxLength={200} className="w-full rounded border px-2 py-1" />
                </div>
                <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}>
                  {t("removeOption", { number })}
                </button>
              </div>
            );
          })}
          <button type="button" disabled={options.length >= 20} className="rounded border px-2 py-1 text-sm" onClick={() => setOptions((current) => [...current, { code: "", label: "" }])}>
            {t("addOption")}
          </button>
          {fieldError("options")}
        </fieldset>
      )}
      {type !== "TEXT" && (
        <>
          <div className="space-y-1">
            <label htmlFor={id("weight")} className="block text-sm font-medium">
              {t("fields.weight")}
            </label>
            <input
              id={id("weight")}
              type="number"
              min={0}
              max={100}
              step={1}
              value={Number.isNaN(weight) ? "" : weight}
              onChange={(event) => setWeight(event.target.valueAsNumber)}
              {...invalid("weight")}
              className="w-32 rounded border px-3 py-2"
            />
            {fieldError("weight")}
          </div>
          {answerInput("scoringAnswer", scoring, setScoring)}
          {answerInput("disqualifyingAnswer", disqualifying, setDisqualifying)}
        </>
      )}
      {errors?.message && !errors.fields && (
        <p role="alert" className="text-sm text-red-700">
          {errors.message}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-60">
          {t("save")}
        </button>
        <button type="button" onClick={onCancel} className="rounded border px-4 py-2">
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
