// Audience-shaped application views (ats-project-scope.md V2, V4, V6, V9;
// tech-stack.md §3 rule 1): explicit allowlists per audience, built here and
// never by stripping fields in components. Admins, Recruiters and Hiring
// Managers in V3a get the full view; an Interviewer in V5 gets only the V6
// allowlist (contact details, documents, the job, the non-cancelled
// interviews they take part in, and scorecards under V7). Nothing here is
// logged (M2).
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { type Db, getDb } from "../db";
import { applications, files, interviewParticipants, interviews, offers, requisitions } from "../db/schema";
import { listApplicationInterviews } from "../interviews";
import { scopeApplicationsFor, scopeOffersFor } from "../policy/filters";
import { type PolicyUser, can } from "../policy/permissions";
import { type ScorecardView, listApplicationScorecards } from "../scorecards";
import { type ApplicationFeedback, getApplicationFeedback } from "./feedback";
import { type DocumentFile, getApplicationDetail } from "./index";

export type OfferView = {
  id: string;
  jobTitle: string;
  salary: string;
  currency: string;
  startDate: string;
  approvalStatus: string;
  candidateResponse: string;
  sentAt: Date | null;
  respondedAt: Date | null;
  createdAt: Date;
};

/** V4: the application's offers with salary, for Admins, Recruiters and Hiring Managers in V3a; empty for anyone else. */
export async function listApplicationOffers(user: PolicyUser, applicationId: string, db: Db = getDb()): Promise<OfferView[]> {
  if (!can(user, "offer.read")) return [];
  return db
    .select({
      id: offers.id,
      jobTitle: offers.jobTitle,
      salary: offers.salary,
      currency: offers.currency,
      startDate: offers.startDate,
      approvalStatus: offers.approvalStatus,
      candidateResponse: offers.candidateResponse,
      sentAt: offers.sentAt,
      respondedAt: offers.respondedAt,
      createdAt: offers.createdAt,
    })
    .from(offers)
    .where(and(eq(offers.applicationId, applicationId), scopeOffersFor(user)))
    .orderBy(asc(offers.createdAt));
}

export type InterviewerInterview = {
  id: string;
  startsAtUtc: Date;
  durationMinutes: number;
  locationOrLink: string;
  status: string;
  participants: string[];
};

/** V6 (Q1): exactly what an Interviewer sees of an application. */
export type InterviewerApplicationView = {
  audience: "interviewer";
  application: { id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null };
  requisition: { reqNumber: string; title: string };
  documents: DocumentFile[];
  interviews: InterviewerInterview[];
  scorecards: ScorecardView[];
};

/**
 * The V6 allowlist for an Interviewer in V5 scope, or undefined (404) when
 * they have no access. Only the non-cancelled interviews they take part in.
 */
export async function getInterviewerApplication(user: PolicyUser, id: string, db: Db = getDb()): Promise<InterviewerApplicationView | undefined> {
  if (!z.uuid().safeParse(id).success) return undefined;
  const [row] = await db
    .select({
      id: applications.id,
      firstName: applications.firstName,
      lastName: applications.lastName,
      email: applications.email,
      phone: applications.phone,
      reqNumber: requisitions.reqNumber,
      title: requisitions.title,
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(and(eq(applications.id, id), scopeApplicationsFor(user)));
  if (!row) return undefined;

  const documents = (
    await db
      .select({ id: files.id, kind: files.kind, deletedAt: files.deletedAt, status: files.status })
      .from(files)
      .where(and(eq(files.ownerType, "APPLICATION"), eq(files.ownerId, id)))
      .orderBy(asc(files.createdAt))
  )
    .filter((file) => file.kind === "CV" || file.kind === "COVER_LETTER")
    .map((file) => ({ id: file.id, kind: file.kind as DocumentFile["kind"], deleted: file.deletedAt !== null || file.status !== "CLEAN" }));

  const mine = await db
    .select({ interviewId: interviewParticipants.interviewId })
    .from(interviewParticipants)
    .innerJoin(interviews, eq(interviews.id, interviewParticipants.interviewId))
    .where(and(eq(interviews.applicationId, id), ne(interviews.status, "CANCELLED"), eq(interviewParticipants.userId, user.id), isNull(interviewParticipants.removedAt)));
  const own = new Set(mine.map((entry) => entry.interviewId));
  const interviewRows = (await listApplicationInterviews(id, new Date(), db))
    .filter((interview) => own.has(interview.id))
    .map((interview) => ({
      id: interview.id,
      startsAtUtc: interview.startsAtUtc,
      durationMinutes: interview.durationMinutes,
      locationOrLink: interview.locationOrLink,
      status: interview.status,
      participants: interview.participants.filter((person) => !person.removed).map((person) => person.name),
    }));

  return {
    audience: "interviewer",
    application: { id: row.id, firstName: row.firstName, lastName: row.lastName, email: row.email, phone: row.phone },
    requisition: { reqNumber: row.reqNumber, title: row.title },
    documents,
    interviews: interviewRows,
    scorecards: await listApplicationScorecards(user, id, db),
  };
}

/** The full view (V2, V4) for Admins, Recruiters and Hiring Managers in V3a. */
export type FullApplicationView = {
  audience: "full";
  application: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    status: string;
    version: number;
    prescreenScore: number;
    isDisqualified: boolean;
    source: string;
    appliedAt: Date;
    consentVersion: string;
    consentAcceptedAt: Date;
    anonymized: boolean;
  };
  requisition: { id: string; reqNumber: string; title: string; department: string; location: string; openingsCount: number };
  documents: DocumentFile[];
  answers: NonNullable<Awaited<ReturnType<typeof getApplicationDetail>>>["answers"];
  others: NonNullable<Awaited<ReturnType<typeof getApplicationDetail>>>["others"];
  timeline: NonNullable<Awaited<ReturnType<typeof getApplicationDetail>>>["timeline"];
  interviews: Awaited<ReturnType<typeof listApplicationInterviews>>;
  feedback: ApplicationFeedback | null;
  offers: OfferView[];
};

/** The JSON read API's view (T5, Q7): exactly what the page renders for this user, or undefined (404). */
export async function getApplicationView(user: PolicyUser, id: string, db: Db = getDb()): Promise<FullApplicationView | InterviewerApplicationView | undefined> {
  if (user.role === "INTERVIEWER") return getInterviewerApplication(user, id, db);
  const detail = await getApplicationDetail(user, id, db);
  if (!detail) return undefined;
  const { application } = detail;
  return {
    audience: "full",
    application: {
      id: application.id,
      firstName: application.firstName,
      lastName: application.lastName,
      email: application.email,
      phone: application.phone,
      status: application.status,
      version: application.version,
      prescreenScore: application.prescreenScore,
      isDisqualified: application.isDisqualified,
      source: application.source,
      appliedAt: application.appliedAt,
      consentVersion: application.consentVersion,
      consentAcceptedAt: application.consentAcceptedAt,
      anonymized: detail.anonymized,
    },
    requisition: {
      id: detail.requisition.id,
      reqNumber: detail.requisition.reqNumber,
      title: detail.requisition.title,
      department: detail.requisition.department,
      location: detail.requisition.location,
      openingsCount: detail.requisition.openingsCount,
    },
    documents: detail.documents,
    answers: detail.answers,
    others: detail.others,
    timeline: detail.timeline,
    interviews: await listApplicationInterviews(id, new Date(), db),
    feedback: (await getApplicationFeedback(user, id, db)) ?? null,
    offers: await listApplicationOffers(user, id, db),
  };
}
