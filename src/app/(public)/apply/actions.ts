"use server";

// The Quick Apply server action (ats-project-scope.md §5.3): turns the form
// data into submitApplication() input and its result into texts for the
// form. No rule lives here; the service decides.
import { headers } from "next/headers";
import { checkApplyAttempt } from "@/server/apply/guard";
import { message } from "@/server/messages";
import { type ApplyInput, type ApplyRoute, type FormQuestion, findJobForRoute, loadApplyForm, submitApplication } from "@/server/apply";

export type ApplyState =
  | { status: "ok" }
  | {
      status: "error";
      /** The status a JSON API would answer with; a server action's response is always 200. */
      httpStatus?: 400 | 429;
      message: string;
      fields: Record<string, string>;
      /** Set when the form must show the current questions or privacy statement again. */
      refresh?: { questions: FormQuestion[]; privacy: { version: string; text: string } };
    };

async function file(value: FormDataEntryValue | null) {
  if (!(value instanceof File) || (value.size === 0 && value.name === "")) return null;
  return { bytes: new Uint8Array(await value.arrayBuffer()), name: value.name };
}

function routeOf(form: FormData): ApplyRoute | null {
  const kind = form.get("routeKind");
  const key = String(form.get("routeKey") ?? "");
  if (kind === "external") return { kind, id: key };
  if (kind === "private") return { kind, slug: key };
  return null;
}

function fieldText(field: string, code: string, maxMb: number | undefined): string {
  if (field === "cv" || field === "coverLetter") {
    if (code === "required") return message("Apply.errors.cvRequired");
    return message(`Files.errors.${code}`, { max: String(maxMb ?? "") });
  }
  if (field.startsWith("answers.")) return message(`Apply.errors.${code}`);
  return message(`Apply.errors.fields.${field}`);
}

export async function applyAction(form: FormData): Promise<ApplyState> {
  const route = routeOf(form);
  // F6: every POST counts; rate limit, honeypot and Turnstile come before anything else.
  const refusal = await checkApplyAttempt({
    headers: await headers(),
    honeypot: String(form.get("website") ?? ""),
    captchaToken: typeof form.get("cf-turnstile-response") === "string" ? String(form.get("cf-turnstile-response")) : null,
    requisitionId: async () => (route ? (await findJobForRoute(route))?.id : undefined),
  });
  if (refusal) return { status: "error", httpStatus: refusal.httpStatus, message: message(`Apply.errors.${refusal.reason}`), fields: {} };
  if (!route) return { status: "error", message: message("Apply.errors.notFound"), fields: {} };
  const answers: Record<string, string[]> = {};
  for (const [name, value] of form.entries()) {
    if (name.startsWith("q_") && typeof value === "string") (answers[name.slice(2)] ??= []).push(value);
  }
  // Checked against questionStampSchema by submitApplication; unparsable JSON fails that check.
  let stamp: unknown = null;
  try {
    stamp = JSON.parse(String(form.get("questionStamp") ?? "[]"));
  } catch {
    stamp = null;
  }
  const input: ApplyInput = {
    route,
    fields: {
      firstName: String(form.get("firstName") ?? ""),
      lastName: String(form.get("lastName") ?? ""),
      email: String(form.get("email") ?? ""),
      phone: String(form.get("phone") ?? ""),
      consent: form.get("consent") === "on",
    },
    answers,
    questionStamp: stamp,
    consentVersion: String(form.get("consentVersion") ?? ""),
    cv: await file(form.get("cv")),
    coverLetter: await file(form.get("coverLetter")),
  };

  const result = await submitApplication(input);
  if (result.ok) return { status: "ok" };
  if (result.reason === "invalid") {
    const fields = Object.fromEntries(Object.entries(result.fields).map(([field, code]) => [field, fieldText(field, code, result.maxMb)]));
    return { status: "error", message: message("Apply.errors.invalid"), fields };
  }
  if (result.reason === "questionsChanged" || result.reason === "consentChanged") {
    const job = await findJobForRoute(route);
    const refresh = job ? await loadApplyForm(job) : undefined;
    return {
      status: "error",
      message: message(`Apply.errors.${result.reason}`),
      fields: {},
      refresh: refresh ? { questions: refresh.questions, privacy: refresh.privacy } : undefined,
    };
  }
  return { status: "error", message: message(`Apply.errors.${result.reason}`), fields: {} };
}
