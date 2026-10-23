// Quick Apply (ats-project-scope.md §5.3, F1–F3, F7, S1–S4, E8, R11):
// submitApplication() is the only way an application is created. Files and
// fields are checked before the transaction; inside it the requisition is
// locked FOR SHARE and checked to be published, duplicates are refused under
// an advisory lock, the question set and the privacy version are compared
// with what the form showed, the answers are scored, and the application,
// files, answers, history and stage email are written together. Logs carry
// IDs only, never names, emails, file names, answers or the hash (M2).
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { getConfig } from "../config";
import { type Tx, getDb, withTransaction } from "../db";
import { applicationHistory, applications, prescreenAnswers, prescreenQuestions, requisitions } from "../db/schema";
import { type ApplyQuestion, applicantErrors, applicantSchema, computeEmailHash, parseAnswers } from "../domain/apply";
import { InvalidAnswerError, scorePrescreen } from "../domain/prescreen/scoring";
import { queueTemplateEmail } from "../email";
import { PdfRejectedError, maxUploadBytes, storePdf } from "../files/store-pdf";
import { validatePdfUpload } from "../files/validate-pdf";
import { findExternalJob, findPrivateJob, type PublicJob } from "../careers";
import { logger } from "../logger";
import { type QuestionRow, toScoredQuestion } from "../prescreen";
import { getSetting } from "../settings";
import { getStageTemplate } from "../templates";

/** Which posting route the candidate came through (§5.3): it decides the source. */
export type ApplyRoute = { kind: "external"; id: string } | { kind: "private"; slug: string };

export type UploadedFile = { bytes: Uint8Array; name: string };

export type ApplyInput = {
  route: ApplyRoute;
  fields: { firstName: string; lastName: string; email: string; phone: string; consent: boolean };
  /** Question ID → the raw form values (several for MULTI). */
  answers: Record<string, string[]>;
  /** The active questions the form showed: ID and `updated_at` (ISO). */
  questionStamp: { id: string; updatedAt: string }[];
  /** The `PRIVACY_STATEMENT_VERSION` the form showed. */
  consentVersion: string;
  cv: UploadedFile | null;
  coverLetter: UploadedFile | null;
};

export type ApplyFieldErrors = Record<string, string>;

export type ApplyResult =
  | { ok: true; applicationId: string; status: "APPLIED" | "REJECTED" }
  | { ok: false; reason: "notFound" | "closed" | "duplicate" | "questionsChanged" | "consentChanged" }
  | { ok: false; reason: "invalid"; fields: ApplyFieldErrors; maxMb?: number };

/** Thrown inside the transaction to roll it back with a result. */
class Refusal extends Error {
  constructor(readonly result: ApplyResult) {
    super("refused");
  }
}

export function findJobForRoute(route: ApplyRoute): Promise<PublicJob | undefined> {
  return route.kind === "external" ? findExternalJob(route.id) : findPrivateJob(route.slug);
}

/** The active questions in order, as the form shows them. */
export function activeQuestions(rows: QuestionRow[]): QuestionRow[] {
  return rows.filter((row) => row.isActive).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime());
}

const stampOf = (rows: QuestionRow[]) =>
  activeQuestions(rows)
    .map((row) => `${row.id}@${row.updatedAt.toISOString()}`)
    .sort()
    .join(",");

async function fileErrors(input: ApplyInput): Promise<{ fields: ApplyFieldErrors; maxMb: number }> {
  const { maxMb, maxBytes } = await maxUploadBytes();
  const fields: ApplyFieldErrors = {};
  const check = async (name: "cv" | "coverLetter", file: UploadedFile | null) => {
    if (!file) return;
    const result = await validatePdfUpload(file.bytes, { maxBytes });
    if (!result.ok) fields[name] = result.code;
  };
  if (!input.cv) fields.cv = "required";
  await check("cv", input.cv);
  await check("coverLetter", input.coverLetter);
  return { fields, maxMb };
}

export async function submitApplication(input: ApplyInput): Promise<ApplyResult> {
  const job = await findJobForRoute(input.route);
  if (!job) return { ok: false, reason: "notFound" };
  if (!job.isPublished) return { ok: false, reason: "closed" };

  // Everything that needs no lock is checked before the transaction, so a
  // bad upload never reaches storage.
  const parsed = applicantSchema.safeParse(input.fields);
  const fields: ApplyFieldErrors = parsed.success ? {} : applicantErrors(parsed.error);
  const files = await fileErrors(input);
  Object.assign(fields, files.fields);
  if (Object.keys(fields).length > 0) return { ok: false, reason: "invalid", fields, maxMb: files.maxMb };
  const applicant = parsed.data!;
  const source = input.route.kind === "external" ? "CAREER_SITE" : "PRIVATE_LINK";

  try {
    return await withTransaction(async (tx) => {
      // 1. Still published, and stays so until the commit.
      const [requisition] = await tx
        .select({ id: requisitions.id, isPublished: requisitions.isPublished })
        .from(requisitions)
        .where(eq(requisitions.id, job.id))
        .for("share");
      if (!requisition?.isPublished) throw new Refusal({ ok: false, reason: "closed" });

      // 2–3. F7 under an advisory lock on (requisition, email hash), so two
      // simultaneous submissions behave like one after the other.
      const emailHash = computeEmailHash(applicant.email, getConfig().emailHashKey);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`apply:${job.id}:${emailHash}`}, 0))`);
      const [duplicate] = await tx
        .select({ id: applications.id })
        .from(applications)
        .where(
          and(
            eq(applications.requisitionId, job.id),
            eq(applications.emailHash, emailHash),
            gt(applications.appliedAt, sql`now() - interval '24 hours'`),
          ),
        )
        .limit(1);
      if (duplicate) throw new Refusal({ ok: false, reason: "duplicate" });

      // 4. The questions the form showed are still the active ones.
      const rows = await tx
        .select()
        .from(prescreenQuestions)
        .where(eq(prescreenQuestions.requisitionId, job.id))
        .orderBy(asc(prescreenQuestions.sortOrder))
        .for("share");
      const shown = input.questionStamp.map((entry) => `${entry.id}@${entry.updatedAt}`).sort().join(",");
      if (shown !== stampOf(rows)) throw new Refusal({ ok: false, reason: "questionsChanged" });

      // 5. The privacy statement the candidate saw is still the current one.
      const consentVersion = await getSetting("PRIVACY_STATEMENT_VERSION", tx);
      if (input.consentVersion !== consentVersion) throw new Refusal({ ok: false, reason: "consentChanged" });

      // 6. Answers and score (S1–S4).
      const active = activeQuestions(rows);
      const formQuestions: ApplyQuestion[] = active.map((row) => ({
        id: row.id,
        questionType: row.questionType,
        options: (row.optionsJson as { code: string }[]) ?? [],
      }));
      const { answers, errors } = parseAnswers(formQuestions, input.answers);
      if (Object.keys(errors).length > 0) throw new Refusal({ ok: false, reason: "invalid", fields: errors });
      let score;
      try {
        score = scorePrescreen(active.map(toScoredQuestion), answers);
      } catch (err) {
        if (err instanceof InvalidAnswerError) throw new Refusal({ ok: false, reason: "invalid", fields: { [`answers.${err.questionId}`]: "invalidOption" } });
        throw err;
      }

      // 7. The application.
      const status = score.isDisqualified ? ("REJECTED" as const) : ("APPLIED" as const);
      const reasonCode = score.isDisqualified ? ("DISQUALIFIED" as const) : null;
      const now = new Date();
      const applicationId = randomUUID();
      await tx.insert(applications).values({
        id: applicationId,
        requisitionId: job.id,
        candidateId: null,
        firstName: applicant.firstName,
        lastName: applicant.lastName,
        email: applicant.email,
        emailHash,
        phone: applicant.phone,
        status,
        reasonCode,
        source,
        prescreenScore: score.total,
        isDisqualified: score.isDisqualified,
        consentAcceptedAt: now,
        consentVersion,
        appliedAt: now,
        dispositionedAt: score.isDisqualified ? now : null,
      });

      // 8. Files and the answered questions (unanswered ones get no row, L3).
      await storeFile(tx, applicationId, "CV", input.cv!);
      if (input.coverLetter) await storeFile(tx, applicationId, "COVER_LETTER", input.coverLetter);
      const points = new Map(score.perQuestion.map((entry) => [entry.questionId, entry.points]));
      const answered = Object.entries(answers);
      if (answered.length > 0) {
        await tx
          .insert(prescreenAnswers)
          .values(answered.map(([questionId, answer]) => ({ applicationId, questionId, answerJson: answer, points: points.get(questionId) ?? 0 })));
      }

      // 9. History, written by the system.
      await tx.insert(applicationHistory).values({ applicationId, fromStatus: null, toStatus: status, changedByUserId: null, reasonCode, isReopen: false });

      // 10. The stage email (E8): acknowledgement now, rejection after the delay.
      const template = await getStageTemplate(status, tx);
      if (template) {
        const delayHours = status === "REJECTED" ? await getSetting("REJECTION_EMAIL_DELAY_HOURS", tx) : 0;
        await queueTemplateEmail(tx, {
          templateId: template.id,
          applicationId,
          startAfter: delayHours > 0 ? new Date(now.getTime() + delayHours * 3_600_000) : undefined,
        });
      }
      logger.info({ application_id: applicationId, requisition_id: job.id, disqualified: score.isDisqualified }, "application created");
      return { ok: true as const, applicationId, status };
    });
  } catch (err) {
    if (err instanceof Refusal) {
      logger.info({ requisition_id: job.id, reason: err.result.ok ? "ok" : err.result.reason }, "application refused");
      return err.result;
    }
    throw err;
  }
}

async function storeFile(tx: Tx, applicationId: string, kind: "CV" | "COVER_LETTER", file: UploadedFile) {
  try {
    await storePdf(tx, { ownerType: "APPLICATION", ownerId: applicationId, kind, originalName: file.name.slice(0, 255) || null, bytes: file.bytes });
  } catch (err) {
    if (err instanceof PdfRejectedError) {
      throw new Refusal({ ok: false, reason: "invalid", fields: { [kind === "CV" ? "cv" : "coverLetter"]: err.code }, maxMb: err.maxMb });
    }
    throw err;
  }
}

export type FormQuestion = {
  id: string;
  text: string;
  type: QuestionRow["questionType"];
  options: { code: string; label: string }[];
  updatedAt: string;
};

export type ApplyFormData = {
  job: PublicJob;
  questions: FormQuestion[];
  privacy: { version: string; text: string };
  maxMb: number;
};

/** What the form shows: the active questions in order, the current privacy statement and the upload limit. */
export async function loadApplyForm(job: PublicJob): Promise<Omit<ApplyFormData, "job">> {
  const rows = await getDb().select().from(prescreenQuestions).where(eq(prescreenQuestions.requisitionId, job.id));
  const [version, text, { maxMb }] = await Promise.all([
    getSetting("PRIVACY_STATEMENT_VERSION"),
    getSetting("PRIVACY_STATEMENT_TEXT"),
    maxUploadBytes(),
  ]);
  return {
    questions: activeQuestions(rows).map((row) => ({
      id: row.id,
      text: row.questionText,
      type: row.questionType,
      options: (row.optionsJson as { code: string; label: string }[]) ?? [],
      updatedAt: row.updatedAt.toISOString(),
    })),
    privacy: { version, text },
    maxMb,
  };
}
