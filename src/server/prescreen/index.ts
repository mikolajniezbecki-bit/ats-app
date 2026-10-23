// Pre-screening questions per requisition (ats-project-scope.md §5.3, L3, L8,
// V4, V6): list, add, edit, delete, deactivate and reorder. Changes are made
// by users who may edit the requisition, in the states where questions may
// change. Once a question has answers, its scoring fields are locked (L3);
// the check runs under a row lock on the question. Logs carry IDs only (M2).
import { and, asc, count, eq, max } from "drizzle-orm";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { rootCause } from "../db/migrator";
import { prescreenAnswers, prescreenQuestions, requisitions } from "../db/schema";
import {
  MAX_QUESTIONS,
  type QuestionAnswerKey,
  type QuestionDefinition,
  type QuestionErrors,
  type QuestionOption,
  scoringFieldsChanged,
  validateQuestion,
} from "../domain/prescreen/questions";
import type { ScoredQuestion } from "../domain/prescreen/scoring";
import { logger } from "../logger";
import { type PolicyUser, can } from "../policy/permissions";
import { type RequisitionRow, findVisibleRequisition } from "../requisitions";

export type QuestionRow = typeof prescreenQuestions.$inferSelect;

export type QuestionResult =
  | { ok: true; question?: QuestionRow; questions?: QuestionRow[] }
  | { ok: false; reason: "invalid"; fields: QuestionErrors }
  | { ok: false; reason: "notFound" | "forbidden" | "stateLocked" | "answered" | "tooMany" | "badOrder" };

const PG_FOREIGN_KEY_VIOLATION = "23503";

/**
 * Questions can change in DRAFT, APPROVED, ON_HOLD and re-approval; never in
 * first-approval PENDING_APPROVAL (L8) or CLOSED.
 */
export function questionsEditable(requisition: Pick<RequisitionRow, "state" | "approvedAt">): boolean {
  if (requisition.state === "PENDING_APPROVAL") return requisition.approvedAt !== null;
  return requisition.state === "DRAFT" || requisition.state === "APPROVED" || requisition.state === "ON_HOLD";
}

/** The definition of a stored question, in the shape the validator returns. */
export function storedDefinition(row: QuestionRow): QuestionDefinition {
  return {
    questionText: row.questionText,
    questionType: row.questionType,
    options: (row.optionsJson as QuestionOption[]) ?? [],
    weight: row.weight,
    scoringAnswer: (row.scoringAnswer as QuestionAnswerKey) ?? null,
    disqualifyingAnswer: (row.disqualifyingAnswer as QuestionAnswerKey) ?? null,
  };
}

/** A stored question for scorePrescreen (S1–S4). */
export function toScoredQuestion(row: QuestionRow): ScoredQuestion {
  const definition = storedDefinition(row);
  return { id: row.id, ...definition, isActive: row.isActive };
}

/** True when the user may change this requisition's questions (Hiring Managers: own drafts only). */
export function canEditQuestions(user: PolicyUser, requisition: RequisitionRow): boolean {
  if (!can(user, "requisition.edit", requisition)) return false;
  return user.role !== "HIRING_MANAGER" || requisition.state === "DRAFT";
}

export function listQuestionRows(requisitionId: string, db: Db | Tx = getDb()): Promise<QuestionRow[]> {
  return db
    .select()
    .from(prescreenQuestions)
    .where(eq(prescreenQuestions.requisitionId, requisitionId))
    .orderBy(asc(prescreenQuestions.sortOrder), asc(prescreenQuestions.createdAt));
}

/** The questions of a requisition the user may see, in order; notFound outside their scope (V9). */
export async function listQuestions(user: PolicyUser, requisitionId: string, db: Db | Tx = getDb()): Promise<QuestionResult> {
  const requisition = await findVisibleRequisition(user, requisitionId, db);
  if (!requisition) return { ok: false, reason: "notFound" };
  return { ok: true, questions: await listQuestionRows(requisitionId, db) };
}

/** Loads and locks the requisition for a change, and checks scope, permission and state. */
async function lockForChange(tx: Tx, user: PolicyUser, requisitionId: string): Promise<{ requisition: RequisitionRow } | QuestionResult> {
  const visible = await findVisibleRequisition(user, requisitionId, tx);
  if (!visible) return { ok: false, reason: "notFound" };
  // Serializes changes per requisition (the 50-question limit, the order).
  const [requisition] = await tx.select().from(requisitions).where(eq(requisitions.id, requisitionId)).for("update");
  if (!canEditQuestions(user, requisition)) return { ok: false, reason: "forbidden" };
  if (!questionsEditable(requisition)) return { ok: false, reason: "stateLocked" };
  return { requisition };
}

async function lockQuestion(tx: Tx, requisitionId: string, questionId: string): Promise<QuestionRow | undefined> {
  if (!z.uuid().safeParse(questionId).success) return undefined;
  const [row] = await tx
    .select()
    .from(prescreenQuestions)
    .where(and(eq(prescreenQuestions.id, questionId), eq(prescreenQuestions.requisitionId, requisitionId)))
    .for("update");
  return row;
}

async function isAnswered(tx: Tx, questionId: string): Promise<boolean> {
  const [found] = await tx.select({ id: prescreenAnswers.id }).from(prescreenAnswers).where(eq(prescreenAnswers.questionId, questionId)).limit(1);
  return found !== undefined;
}

const columns = (definition: QuestionDefinition) => ({
  questionText: definition.questionText,
  questionType: definition.questionType,
  optionsJson: definition.options,
  weight: definition.weight,
  scoringAnswer: definition.scoringAnswer,
  disqualifyingAnswer: definition.disqualifyingAnswer,
});

export async function createQuestion(tx: Tx, user: PolicyUser, requisitionId: string, input: unknown): Promise<QuestionResult> {
  const locked = await lockForChange(tx, user, requisitionId);
  if (!("requisition" in locked)) return locked;
  const validated = validateQuestion(input);
  if (!validated.ok) return { ok: false, reason: "invalid", fields: validated.errors };
  const [{ total, last }] = await tx
    .select({ total: count(), last: max(prescreenQuestions.sortOrder) })
    .from(prescreenQuestions)
    .where(eq(prescreenQuestions.requisitionId, requisitionId));
  if (total >= MAX_QUESTIONS) return { ok: false, reason: "tooMany" };
  const [question] = await tx
    .insert(prescreenQuestions)
    .values({ requisitionId, ...columns(validated.question), isActive: validated.isActive ?? true, sortOrder: (last ?? -1) + 1 })
    .returning();
  logger.info({ requisition_id: requisitionId, question_id: question.id, user_id: user.id }, "pre-screening question created");
  return { ok: true, question };
}

/**
 * Edits a question: `input` holds the fields to change, merged with the
 * stored ones and checked as a whole. An answered question keeps its
 * scoring fields (L3); its text and active flag can still change.
 */
export async function updateQuestion(tx: Tx, user: PolicyUser, requisitionId: string, questionId: string, input: unknown): Promise<QuestionResult> {
  const locked = await lockForChange(tx, user, requisitionId);
  if (!("requisition" in locked)) return locked;
  const current = await lockQuestion(tx, requisitionId, questionId);
  if (!current) return { ok: false, reason: "notFound" };
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, reason: "invalid", fields: { _: "invalid" } };
  const stored = storedDefinition(current);
  const merged = { ...stored, isActive: current.isActive, ...(input as Record<string, unknown>) };
  const validated = validateQuestion(merged);
  if (!validated.ok) return { ok: false, reason: "invalid", fields: validated.errors };
  if (scoringFieldsChanged(stored, validated.question).length > 0 && (await isAnswered(tx, questionId))) {
    return { ok: false, reason: "answered" };
  }
  const [question] = await tx
    .update(prescreenQuestions)
    .set({ ...columns(validated.question), isActive: validated.isActive ?? current.isActive })
    .where(eq(prescreenQuestions.id, questionId))
    .returning();
  logger.info({ requisition_id: requisitionId, question_id: questionId, user_id: user.id }, "pre-screening question updated");
  return { ok: true, question };
}

/** Deletes an unanswered question; an answered one (or one answered concurrently) can only be deactivated (L3). */
export async function deleteQuestion(tx: Tx, user: PolicyUser, requisitionId: string, questionId: string): Promise<QuestionResult> {
  const locked = await lockForChange(tx, user, requisitionId);
  if (!("requisition" in locked)) return locked;
  const current = await lockQuestion(tx, requisitionId, questionId);
  if (!current) return { ok: false, reason: "notFound" };
  if (await isAnswered(tx, questionId)) return { ok: false, reason: "answered" };
  try {
    await tx.transaction((sp) => sp.delete(prescreenQuestions).where(eq(prescreenQuestions.id, questionId)));
  } catch (err) {
    if ((rootCause(err) as { code?: string }).code === PG_FOREIGN_KEY_VIOLATION) return { ok: false, reason: "answered" };
    throw err;
  }
  logger.info({ requisition_id: requisitionId, question_id: questionId, user_id: user.id }, "pre-screening question deleted");
  return { ok: true, question: current };
}

const orderSchema = z.object({ questionIds: z.array(z.uuid()).max(MAX_QUESTIONS) }).strict();

/** Sets the order: `questionIds` must be exactly this requisition's questions. */
export async function reorderQuestions(tx: Tx, user: PolicyUser, requisitionId: string, input: unknown): Promise<QuestionResult> {
  const locked = await lockForChange(tx, user, requisitionId);
  if (!("requisition" in locked)) return locked;
  const parsed = orderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "badOrder" };
  const ids = parsed.data.questionIds;
  const existing = await listQuestionRows(requisitionId, tx);
  const known = new Set(existing.map((row) => row.id));
  if (ids.length !== existing.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
    return { ok: false, reason: "badOrder" };
  }
  for (const [index, id] of ids.entries()) {
    await tx.update(prescreenQuestions).set({ sortOrder: index }).where(eq(prescreenQuestions.id, id));
  }
  logger.info({ requisition_id: requisitionId, user_id: user.id }, "pre-screening questions reordered");
  return { ok: true, questions: await listQuestionRows(requisitionId, tx) };
}
