// Pre-screening scoring (ats-project-scope.md S1–S4): one pure function, so
// Quick Apply (task 24) scores inside its transaction exactly as the tests do.
import type { QuestionAnswerKey, QuestionOption, QuestionType } from "./questions";

export type ScoredQuestion = {
  id: string;
  questionType: QuestionType;
  options: QuestionOption[];
  weight: number;
  scoringAnswer: QuestionAnswerKey;
  disqualifyingAnswer: QuestionAnswerKey;
  isActive: boolean;
};

/** `YES_NO` "YES"/"NO", `SINGLE` a code, `MULTI` an array of codes, `TEXT` a string. */
export type Answer = string | string[];

export type ScoreResult = {
  perQuestion: { questionId: string; points: number }[];
  total: number;
  isDisqualified: boolean;
};

/** An answer that doesn't fit its question (unknown code or wrong shape, S4). */
export class InvalidAnswerError extends Error {
  override name = "InvalidAnswerError";
  constructor(readonly questionId: string) {
    super(`Invalid answer for question ${questionId}`);
  }
}

const isUnanswered = (answer: Answer | undefined) =>
  answer === undefined || (Array.isArray(answer) ? answer.length === 0 : answer === "");

/**
 * Scores `answers` (question ID → answer) against the active questions.
 * Unanswered questions get 0 and don't disqualify; answers to inactive or
 * unknown questions are ignored; a disqualified result still has its total.
 */
export function scorePrescreen(questions: readonly ScoredQuestion[], answers: Readonly<Record<string, Answer | undefined>>): ScoreResult {
  const perQuestion: ScoreResult["perQuestion"] = [];
  let isDisqualified = false;
  for (const question of questions) {
    if (!question.isActive) continue;
    const answer = answers[question.id];
    let points = 0;
    if (!isUnanswered(answer)) {
      const codes = new Set(question.options.map((option) => option.code));
      if (question.questionType === "TEXT") {
        // S1: informational only.
        if (typeof answer !== "string") throw new InvalidAnswerError(question.id);
      } else if (question.questionType === "MULTI") {
        if (!Array.isArray(answer) || answer.some((code) => !codes.has(code))) throw new InvalidAnswerError(question.id);
        const selected = new Set(answer);
        const scoring = Array.isArray(question.scoringAnswer) ? new Set(question.scoringAnswer) : undefined;
        if (scoring && scoring.size === selected.size && [...scoring].every((code) => selected.has(code))) points = question.weight;
        if (Array.isArray(question.disqualifyingAnswer) && question.disqualifyingAnswer.some((code) => selected.has(code))) isDisqualified = true;
      } else {
        if (typeof answer !== "string" || !codes.has(answer)) throw new InvalidAnswerError(question.id);
        if (answer === question.scoringAnswer) points = question.weight;
        if (answer === question.disqualifyingAnswer) isDisqualified = true;
      }
    }
    perQuestion.push({ questionId: question.id, points });
  }
  return { perQuestion, total: perQuestion.reduce((sum, entry) => sum + entry.points, 0), isDisqualified };
}
