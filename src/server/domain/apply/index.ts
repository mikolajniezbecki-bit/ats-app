// Quick Apply input rules (ats-project-scope.md §5.3, §7 `applications`
// limits, F7): one schema for the contact fields, the pre-screening answer
// rules, and the email hash. Pure: the server action and the tests use it,
// and the form mirrors it.
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { QuestionType } from "../prescreen/questions";
import type { Answer } from "../prescreen/scoring";

export const MAX_TEXT_ANSWER = 2_000;
const PHONE_PATTERN = /^[0-9 +\-()]{6,30}$/;

/** F7: HMAC-SHA-256 of the trimmed, lower-cased email, as 64 lower-case hex characters. */
export function computeEmailHash(email: string, key: string): string {
  return createHmac("sha256", key).update(email.trim().toLowerCase()).digest("hex");
}

export const applicantSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().max(254).pipe(z.email()),
  phone: z
    .string()
    .trim()
    .regex(PHONE_PATTERN)
    .refine((value) => (value.match(/[0-9]/g) ?? []).length >= 6),
  consent: z.literal(true),
});

export type Applicant = z.infer<typeof applicantSchema>;

/** Field → error code from a failed parse (the field's own text in messages/en.json). */
export function applicantErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) errors[String(issue.path[0] ?? "_")] ??= "invalid";
  return errors;
}

/** The active questions the form showed (ID and `updated_at`), posted back as JSON. */
export const questionStampSchema = z.array(z.object({ id: z.string().max(100), updatedAt: z.string().max(40) }).strict()).max(50);

export type QuestionStamp = z.infer<typeof questionStampSchema>;

export type ApplyQuestion = { id: string; questionType: QuestionType; options: { code: string }[] };

/**
 * Turns the raw form answers into scorePrescreen answers (§5.3 Question
 * rules): YES_NO and SINGLE must be answered with one of the question's
 * codes; MULTI is zero or more codes (none = unanswered); TEXT is optional,
 * at most 2,000 characters (empty = unanswered). Returns the answers and the
 * field errors keyed `answers.<questionId>`.
 */
export function parseAnswers(
  questions: readonly ApplyQuestion[],
  raw: Readonly<Record<string, string[]>>,
): { answers: Record<string, Answer>; errors: Record<string, string> } {
  const answers: Record<string, Answer> = {};
  const errors: Record<string, string> = {};
  const known = new Set(questions.map((question) => question.id));
  for (const id of Object.keys(raw)) if (!known.has(id)) errors[`answers.${id}`] = "unknownQuestion";
  for (const question of questions) {
    const values = (raw[question.id] ?? []).map((value) => value.trim()).filter((value) => value !== "");
    const codes = new Set(question.options.map((option) => option.code));
    const key = `answers.${question.id}`;
    if (question.questionType === "TEXT") {
      const text = values.join("\n");
      if (text.length > MAX_TEXT_ANSWER) errors[key] = "textTooLong";
      else if (text !== "") answers[question.id] = text;
    } else if (question.questionType === "MULTI") {
      if (values.some((value) => !codes.has(value))) errors[key] = "invalidOption";
      else if (values.length > 0) answers[question.id] = [...new Set(values)];
    } else if (values.length === 0) errors[key] = "answerRequired";
    else if (values.length > 1 || !codes.has(values[0])) errors[key] = "invalidOption";
    else answers[question.id] = values[0];
  }
  return { answers, errors };
}
