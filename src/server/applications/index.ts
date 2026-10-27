// Recruiter workbench read models (ats-project-scope.md §5.4, E4, E5, RT4,
// TO-01; tech-stack.md D6): the application list per requisition and the
// application page. Every read takes the user and goes through
// scopeApplicationsFor, so task 34 adds the Hiring Manager and Interviewer
// shaping here rather than in components. Nothing here is logged: it is
// personal data and email content (M2).
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { activeQuestions } from "../apply";
import { type Db, getDb } from "../db";
import {
  APPLICATION_STATUSES,
  applicationHistory,
  applications,
  emailLog,
  files,
  interviewScorecards,
  interviews,
  masterData,
  offers,
  prescreenAnswers,
  prescreenQuestions,
  requisitions,
  users,
} from "../db/schema";
import { type PipelineStatus, checkTransition } from "../domain/pipeline";
import { hiredCount } from "../pipeline";
import { type PolicyUser, can } from "../policy/permissions";
import { scopeApplicationsFor, scopeRequisitionsFor } from "../policy/filters";
import { findVisibleRequisition } from "../requisitions";
import { type TimelineEntry, buildTimeline } from "./timeline";

export { type TimelineEntry, buildTimeline, emailTime } from "./timeline";

export const APPLICATION_LIST_PAGE_SIZE = 50;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Another application with the same `email_hash` (TO-01: linked, never merged). */
export type RelatedApplication = { id: string; requisitionId: string; reqNumber: string; title: string; status: ApplicationStatus };

export type ApplicationListRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  status: ApplicationStatus;
  /** The version a bulk move sends back (R9). */
  version: number;
  prescreenScore: number;
  isDisqualified: boolean;
  source: "CAREER_SITE" | "PRIVATE_LINK";
  appliedAt: Date;
  anonymized: boolean;
  hasFailedEmail: boolean;
  /** Applications on this requisition with the same email address, this one included; 1 when not grouped. */
  groupSize: number;
  /** The first row of a group on this page; the list shows the group row above it. */
  groupStart: boolean;
  alsoAppliedTo: RelatedApplication[];
};

export type ApplicationList = {
  requisition: { id: string; reqNumber: string; title: string };
  rows: ApplicationListRow[];
  counts: Record<ApplicationStatus, number>;
  total: number;
  page: number;
  pages: number;
};

// Written out with explicit table names: Drizzle renders columns inside a
// raw subquery unqualified, and `id` would then bind to email_log.
const failedEmail = sql<boolean>`exists (select 1 from email_log failed where failed.application_id = "applications"."id" and failed.status = 'FAILED')`;

/** Other applications with one of `hashes`, outside `excludeRequisitionId` or not `excludeId`, that `user` may read. */
async function relatedByHash(user: PolicyUser, hashes: string[], db: Db, exclude: { requisitionId?: string; id?: string }) {
  if (hashes.length === 0) return [];
  return db
    .select({
      id: applications.id,
      emailHash: applications.emailHash,
      requisitionId: applications.requisitionId,
      reqNumber: requisitions.reqNumber,
      title: requisitions.title,
      status: applications.status,
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(
      and(
        scopeApplicationsFor(user),
        inArray(applications.emailHash, hashes),
        exclude.requisitionId ? ne(applications.requisitionId, exclude.requisitionId) : undefined,
        exclude.id ? ne(applications.id, exclude.id) : undefined,
      ),
    )
    .orderBy(asc(requisitions.reqNumber), desc(applications.appliedAt));
}

function toRelated(row: RelatedApplication): RelatedApplication {
  return { id: row.id, requisitionId: row.requisitionId, reqNumber: row.reqNumber, title: row.title, status: row.status };
}

/**
 * The applications of a requisition `user` can see, 50 per page (Q2).
 * Applications sharing an `email_hash` sit together (Q1): groups are ordered
 * by their newest `applied_at`, rows inside a group newest first.
 * Anonymized applications (no hash) are never grouped. Undefined when the
 * requisition isn't visible.
 */
export async function listRequisitionApplications(
  user: PolicyUser,
  requisitionId: string,
  options: { status?: ApplicationStatus; page?: number } = {},
  db: Db = getDb(),
): Promise<ApplicationList | undefined> {
  const requisition = await findVisibleRequisition(user, requisitionId, db);
  if (!requisition) return undefined;
  const inRequisition = and(scopeApplicationsFor(user), eq(applications.requisitionId, requisitionId));

  const counts = Object.fromEntries(APPLICATION_STATUSES.map((status) => [status, 0])) as Record<ApplicationStatus, number>;
  const grouped = await db.select({ status: applications.status, total: count() }).from(applications).where(inRequisition).groupBy(applications.status);
  for (const { status, total } of grouped) counts[status] = total;
  const total = options.status ? counts[options.status] : Object.values(counts).reduce((sum, n) => sum + n, 0);
  const pages = Math.max(1, Math.ceil(total / APPLICATION_LIST_PAGE_SIZE));
  const page = Math.min(Math.max(1, options.page ?? 1), pages);

  const groupKey = sql`coalesce(${applications.emailHash}, ${applications.id}::text)`;
  const groupLatest = sql`max(${applications.appliedAt}) over (partition by ${groupKey})`;
  const rows = await db
    .select({
      id: applications.id,
      firstName: applications.firstName,
      lastName: applications.lastName,
      email: applications.email,
      emailHash: applications.emailHash,
      status: applications.status,
      version: applications.version,
      prescreenScore: applications.prescreenScore,
      isDisqualified: applications.isDisqualified,
      source: applications.source,
      appliedAt: applications.appliedAt,
      anonymizedAt: applications.anonymizedAt,
      hasFailedEmail: failedEmail,
      groupSize: sql<number>`(count(*) over (partition by ${groupKey}))::int`,
    })
    .from(applications)
    .where(and(inRequisition, options.status ? eq(applications.status, options.status) : undefined))
    .orderBy(desc(groupLatest), groupKey, desc(applications.appliedAt), desc(applications.id))
    .limit(APPLICATION_LIST_PAGE_SIZE)
    .offset((page - 1) * APPLICATION_LIST_PAGE_SIZE);

  const hashes = [...new Set(rows.flatMap((row) => (row.emailHash ? [row.emailHash] : [])))];
  const related = await relatedByHash(user, hashes, db, { requisitionId });

  return {
    requisition: { id: requisition.id, reqNumber: requisition.reqNumber, title: requisition.title },
    rows: rows.map((row, index) => ({
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      status: row.status,
      version: row.version,
      prescreenScore: row.prescreenScore,
      isDisqualified: row.isDisqualified,
      source: row.source,
      appliedAt: row.appliedAt,
      anonymized: row.anonymizedAt !== null,
      hasFailedEmail: row.hasFailedEmail,
      groupSize: row.groupSize,
      groupStart: row.groupSize > 1 && (index === 0 || rows[index - 1].emailHash !== row.emailHash),
      alsoAppliedTo: row.emailHash ? related.filter((other) => other.emailHash === row.emailHash).map(toRelated) : [],
    })),
    counts,
    total,
    page,
    pages,
  };
}

export type DocumentFile = { id: string; kind: "CV" | "COVER_LETTER"; deleted: boolean };

export type AnswerView = {
  questionId: string;
  text: string;
  type: "YES_NO" | "SINGLE" | "MULTI" | "TEXT";
  /** Option labels (codes when a label is gone); TEXT as one plain string; empty when not answered. */
  answer: string[];
  answered: boolean;
  points: number;
  questionActive: boolean;
};

/** A target the status control offers (Q4); a reopen needs a comment (R3). */
export type StatusTarget = { status: PipelineStatus; needsComment: boolean };

export type ApplicationDetail = {
  application: typeof applications.$inferSelect;
  /** The requisition header (V3b: shown on the application page, without the requisition's own pages). */
  requisition: {
    id: string;
    reqNumber: string;
    title: string;
    state: string;
    department: string;
    location: string;
    openingsCount: number;
    /** False for a Hiring Manager who reaches the application only through V3b. */
    visible: boolean;
  };
  anonymized: boolean;
  documents: DocumentFile[];
  answers: AnswerView[];
  others: RelatedApplication[];
  timeline: TimelineEntry[];
  hasFailedEmail: boolean;
  targets: StatusTarget[];
};

function answerLabels(type: AnswerView["type"], raw: unknown, options: { code: string; label: string }[]): string[] {
  const label = (code: string) => options.find((option) => option.code === code)?.label ?? code;
  if (type === "TEXT") return typeof raw === "string" && raw !== "" ? [raw] : [];
  if (Array.isArray(raw)) return raw.map((code) => label(String(code)));
  return typeof raw === "string" ? [label(raw)] : [];
}

/**
 * Pre-screening for the page: every stored answer, including questions
 * deactivated since, then the active questions without one ("Not answered",
 * 0 points), in the questions' order.
 */
async function loadAnswers(applicationId: string, requisitionId: string, db: Db): Promise<AnswerView[]> {
  const questions = await db.select().from(prescreenQuestions).where(eq(prescreenQuestions.requisitionId, requisitionId));
  const stored = await db.select().from(prescreenAnswers).where(eq(prescreenAnswers.applicationId, applicationId));
  const active = new Set(activeQuestions(questions).map((question) => question.id));
  return questions
    .filter((question) => active.has(question.id) || stored.some((answer) => answer.questionId === question.id))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime())
    .map((question) => {
      const answer = stored.find((row) => row.questionId === question.id);
      const labels = answer ? answerLabels(question.questionType, answer.answerJson, (question.optionsJson as { code: string; label: string }[]) ?? []) : [];
      return {
        questionId: question.id,
        text: question.questionText,
        type: question.questionType,
        answer: labels,
        answered: labels.length > 0,
        points: answer?.points ?? 0,
        questionActive: active.has(question.id),
      };
    });
}

async function loadTimeline(applicationId: string, anonymized: boolean, db: Db): Promise<TimelineEntry[]> {
  const [history, emails, interviewRows, scorecards, offerRows] = await Promise.all([
    db
      .select({
        id: applicationHistory.id,
        createdAt: applicationHistory.createdAt,
        fromStatus: applicationHistory.fromStatus,
        toStatus: applicationHistory.toStatus,
        changedBy: users.name,
        comment: applicationHistory.comment,
        reasonCode: applicationHistory.reasonCode,
        isReopen: applicationHistory.isReopen,
      })
      .from(applicationHistory)
      .leftJoin(users, eq(users.id, applicationHistory.changedByUserId))
      .where(eq(applicationHistory.applicationId, applicationId)),
    db
      .select({
        id: emailLog.id,
        createdAt: emailLog.createdAt,
        updatedAt: emailLog.updatedAt,
        sentAt: emailLog.sentAt,
        scheduledFor: emailLog.scheduledFor,
        subject: emailLog.subject,
        recipient: emailLog.recipient,
        bodyRendered: emailLog.bodyRendered,
        audience: emailLog.audience,
        status: emailLog.status,
        error: emailLog.error,
      })
      .from(emailLog)
      .where(eq(emailLog.applicationId, applicationId)),
    db
      .select({ id: interviews.id, startsAtUtc: interviews.startsAtUtc, durationMinutes: interviews.durationMinutes, status: interviews.status })
      .from(interviews)
      .where(eq(interviews.applicationId, applicationId)),
    db
      .select({
        id: interviewScorecards.id,
        interviewer: users.name,
        overallRating: interviewScorecards.overallRating,
        thumbsUp: interviewScorecards.thumbsUp,
        submittedAt: interviewScorecards.submittedAt,
      })
      .from(interviewScorecards)
      .innerJoin(interviews, eq(interviews.id, interviewScorecards.interviewId))
      .innerJoin(users, eq(users.id, interviewScorecards.interviewerId))
      .where(eq(interviews.applicationId, applicationId)),
    db
      .select({
        id: offers.id,
        createdAt: offers.createdAt,
        jobTitle: offers.jobTitle,
        approvalStatus: offers.approvalStatus,
        candidateResponse: offers.candidateResponse,
        sentAt: offers.sentAt,
        respondedAt: offers.respondedAt,
      })
      .from(offers)
      .where(eq(offers.applicationId, applicationId)),
  ]);
  return buildTimeline({ anonymized, history, emails, interviews: interviewRows, scorecards, offers: offerRows });
}

/**
 * The status control's targets (Q4): every status checkTransition allows
 * now, for `user` (R4 corrections are Admin only). A reopen or a correction
 * is offered with its comment marked required; the API checks everything
 * again.
 */
async function statusTargets(
  user: PolicyUser,
  application: typeof applications.$inferSelect,
  requisition: { id: string; state: string; approvedAt: Date | null; openingsCount: number },
  db: Db,
): Promise<StatusTarget[]> {
  if (application.anonymizedAt) return [];
  const [accepted] = await db
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.applicationId, application.id), eq(offers.candidateResponse, "ACCEPTED")))
    .limit(1);
  const ctx = {
    requisitionState: requisition.state as Parameters<typeof checkTransition>[2]["requisitionState"],
    requisitionApprovedAt: requisition.approvedAt,
    hasAcceptedOffer: accepted !== undefined,
    hiredCount: await hiredCount(db, requisition.id),
    openingsCount: requisition.openingsCount,
    canCorrectHired: can(user, "application.correctHired"),
    // Any comment: whether one is needed is the control's business (needsComment).
    comment: "-",
  };
  return APPLICATION_STATUSES.flatMap((status) => {
    const check = checkTransition(application.status, status, ctx);
    return check.ok ? [{ status, needsComment: check.isReopen || check.isCorrection === true }] : [];
  });
}

/** The application page for `user`, or undefined when it doesn't exist or isn't visible. */
export async function getApplicationDetail(user: PolicyUser, id: string, db: Db = getDb()): Promise<ApplicationDetail | undefined> {
  if (!z.uuid().safeParse(id).success) return undefined;
  const department = alias(masterData, "department");
  const location = alias(masterData, "location");
  const [row] = await db
    .select({
      application: applications,
      requisition: {
        id: requisitions.id,
        reqNumber: requisitions.reqNumber,
        title: requisitions.title,
        state: requisitions.state,
        approvedAt: requisitions.approvedAt,
        openingsCount: requisitions.openingsCount,
        department: department.label,
        location: location.label,
        visible: sql<boolean>`${scopeRequisitionsFor(user)}`,
      },
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(department, eq(department.id, requisitions.departmentId))
    .innerJoin(location, eq(location.id, requisitions.locationId))
    .where(and(scopeApplicationsFor(user), eq(applications.id, id)));
  if (!row) return undefined;
  const { application } = row;
  const anonymized = application.anonymizedAt !== null;

  const documents = anonymized
    ? []
    : (
        await db
          .select({ id: files.id, kind: files.kind, deletedAt: files.deletedAt, status: files.status, createdAt: files.createdAt })
          .from(files)
          .where(and(eq(files.ownerType, "APPLICATION"), eq(files.ownerId, id), inArray(files.kind, ["CV", "COVER_LETTER"])))
          .orderBy(asc(files.createdAt))
      )
        .map((file) => ({ id: file.id, kind: file.kind as DocumentFile["kind"], deleted: file.deletedAt !== null || file.status !== "CLEAN" }))
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "CV" ? -1 : 1));

  const [answers, others, timeline, targets] = await Promise.all([
    anonymized ? Promise.resolve([]) : loadAnswers(id, application.requisitionId, db),
    application.emailHash ? relatedByHash(user, [application.emailHash], db, { id }) : Promise.resolve([]),
    loadTimeline(id, anonymized, db),
    statusTargets(user, application, row.requisition, db),
  ]);

  return {
    application,
    requisition: {
      id: row.requisition.id,
      reqNumber: row.requisition.reqNumber,
      title: row.requisition.title,
      state: row.requisition.state,
      department: row.requisition.department,
      location: row.requisition.location,
      openingsCount: row.requisition.openingsCount,
      visible: row.requisition.visible,
    },
    anonymized,
    documents,
    answers,
    others: others.map(toRelated),
    timeline,
    hasFailedEmail: timeline.some((entry) => entry.kind === "email" && entry.failed),
    targets,
  };
}

/** For the requisition page link "Applications (n)". */
export async function countRequisitionApplications(user: PolicyUser, requisitionId: string, db: Db = getDb()): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(applications)
    .where(and(scopeApplicationsFor(user), eq(applications.requisitionId, requisitionId)));
  return total;
}
