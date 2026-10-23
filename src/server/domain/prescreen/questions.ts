// Pre-screening question rules (ats-project-scope.md §5.3 "Question rules",
// S1, §7 `prescreen_questions`). One Zod schema checks a question as a whole,
// so the API and the editor agree. Pure: no database or framework code.
import { z } from "zod";

export const QUESTION_TYPES = ["YES_NO", "SINGLE", "MULTI", "TEXT"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const OPTION_CODE_PATTERN = /^[A-Z0-9_]{1,30}$/;
export const MAX_QUESTIONS = 50;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 20;
export const MAX_WEIGHT = 100;
export const MAX_QUESTION_TEXT = 500;

export type QuestionOption = { code: string; label: string };
/** `YES_NO` and `SINGLE`: one code; `MULTI`: a set of codes. */
export type QuestionAnswerKey = string | string[] | null;

/** The options of every `YES_NO` question, set by the server. */
export const YES_NO_OPTIONS: QuestionOption[] = [
  { code: "YES", label: "Yes" },
  { code: "NO", label: "No" },
];

const option = z
  .object({
    code: z.string().regex(OPTION_CODE_PATTERN, { message: "optionCode" }),
    label: z.string().trim().min(1, { message: "optionLabel" }).max(200, { message: "optionLabel" }),
  })
  .strict();

const answerKey = z.union([z.string(), z.array(z.string()), z.null()]);

/** What a client sends for a new question or a full edit. */
export const questionInputSchema = z
  .object({
    questionText: z.string().trim().min(1).max(MAX_QUESTION_TEXT),
    questionType: z.enum(QUESTION_TYPES),
    options: z.array(option).optional(),
    weight: z.number().int().min(0).max(MAX_WEIGHT).default(0),
    scoringAnswer: answerKey.default(null),
    disqualifyingAnswer: answerKey.default(null),
    isActive: z.boolean().optional(),
  })
  .strict();

export type QuestionInput = z.input<typeof questionInputSchema>;

/** A question as stored, after the per-type rules. */
export type QuestionDefinition = {
  questionText: string;
  questionType: QuestionType;
  options: QuestionOption[];
  weight: number;
  scoringAnswer: QuestionAnswerKey;
  disqualifyingAnswer: QuestionAnswerKey;
};

export type QuestionErrors = Record<string, string>;

const isSingle = (value: QuestionAnswerKey): value is string => typeof value === "string";
const isSet = (value: QuestionAnswerKey): value is string[] => Array.isArray(value);

/**
 * Checks a question against the per-type table (§5.3): returns the stored
 * form, or field → error code. `YES_NO` options are always YES/NO, `TEXT`
 * has none, weight 0 and no answers (S1).
 */
export function validateQuestion(input: unknown): { ok: true; question: QuestionDefinition; isActive?: boolean } | { ok: false; errors: QuestionErrors } {
  const parsed = questionInputSchema.safeParse(input);
  if (!parsed.success) {
    const errors: QuestionErrors = {};
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) errors[key] = "notAllowed";
        continue;
      }
      const field = String(issue.path[0] ?? "_");
      errors[field] ??= field === "options" && (issue.message === "optionCode" || issue.message === "optionLabel") ? issue.message : "invalid";
    }
    return { ok: false, errors };
  }
  const data = parsed.data;
  const errors: QuestionErrors = {};
  const type = data.questionType;
  let options: QuestionOption[];

  if (type === "YES_NO") options = YES_NO_OPTIONS;
  else if (type === "TEXT") {
    options = [];
    if (data.options && data.options.length > 0) errors.options = "textNoOptions";
  } else {
    options = data.options ?? [];
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) errors.options = "optionCount";
    else if (new Set(options.map((o) => o.code)).size !== options.length) errors.options = "duplicateCode";
  }

  const { scoringAnswer, disqualifyingAnswer, weight } = data;
  if (type === "TEXT") {
    if (weight !== 0) errors.weight = "textNoWeight";
    if (scoringAnswer !== null) errors.scoringAnswer = "textNoAnswer";
    if (disqualifyingAnswer !== null) errors.disqualifyingAnswer = "textNoAnswer";
  } else {
    const codes = new Set(options.map((o) => o.code));
    const check = (field: "scoringAnswer" | "disqualifyingAnswer", value: QuestionAnswerKey) => {
      if (value === null) return;
      if (type === "MULTI") {
        if (!isSet(value) || value.length === 0) errors[field] = "answerSet";
        else if (new Set(value).size !== value.length || value.some((code) => !codes.has(code))) errors[field] = "answerCode";
      } else if (!isSingle(value)) errors[field] = "answerSingle";
      else if (!codes.has(value)) errors[field] = "answerCode";
    };
    check("scoringAnswer", scoringAnswer);
    check("disqualifyingAnswer", disqualifyingAnswer);
    if (!errors.scoringAnswer && !errors.disqualifyingAnswer && scoringAnswer !== null && disqualifyingAnswer !== null) {
      const overlap =
        type === "MULTI"
          ? (scoringAnswer as string[]).some((code) => (disqualifyingAnswer as string[]).includes(code))
          : scoringAnswer === disqualifyingAnswer;
      if (overlap) errors.disqualifyingAnswer = type === "MULTI" ? "answersOverlap" : "answersEqual";
    }
    if ((weight > 0) !== (scoringAnswer !== null) && !errors.scoringAnswer) errors.weight = "weightNeedsAnswer";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    question: {
      questionText: data.questionText,
      questionType: type,
      options,
      weight,
      scoringAnswer: type === "MULTI" && isSet(scoringAnswer) ? [...scoringAnswer].sort() : scoringAnswer,
      disqualifyingAnswer: type === "MULTI" && isSet(disqualifyingAnswer) ? [...disqualifyingAnswer].sort() : disqualifyingAnswer,
    },
    isActive: data.isActive,
  };
}

/** True when two answer keys mean the same (sets compared without order). */
export function sameAnswerKey(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
  return (a ?? null) === (b ?? null);
}

/** The fields L3 locks once a question has answers. */
export function scoringFieldsChanged(stored: QuestionDefinition, next: QuestionDefinition): string[] {
  const changed: string[] = [];
  if (stored.questionType !== next.questionType) changed.push("questionType");
  if (JSON.stringify(stored.options) !== JSON.stringify(next.options)) changed.push("options");
  if (stored.weight !== next.weight) changed.push("weight");
  if (!sameAnswerKey(stored.scoringAnswer, next.scoringAnswer)) changed.push("scoringAnswer");
  if (!sameAnswerKey(stored.disqualifyingAnswer, next.disqualifyingAnswer)) changed.push("disqualifyingAnswer");
  return changed;
}
