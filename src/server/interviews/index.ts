// Interviews (ats-project-scope.md §5.5 I1–I8, R12; tech-stack.md D3, J1,
// J4, M2): scheduling, rescheduling, participant changes, cancellation and
// the outcome. Every invite is its own email with an `.ics` that lists only
// its recipient (I2); a change keeps the UID and increments the sequence
// once per save (I3–I5). `ics_sequence` doubles as the expected version of
// a save (Q6). Nothing here touches the application's status (I8); R12 is
// called by the status service. Logs carry IDs only (M2).
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { buildInvite } from "../adapters/calendar";
import { getConfig } from "../config";
import { type Db, type Tx, getDb } from "../db";
import { applications, interviewParticipants, interviewScorecards, interviews, requisitions, users } from "../db/schema";
import {
  MAX_DURATION_MINUTES,
  MAX_LOCATION_LENGTH,
  MAX_PARTICIPANTS,
  MIN_DURATION_MINUTES,
  isValidTimeZone,
  localToUtc,
  participantChanges,
  timingChanged,
  utcToLocal,
} from "../domain/interviews";
import { isOpenStatus } from "../domain/pipeline";
import { formatInterviewDateTime } from "../domain/tokens/format";
import { buildApplicationTokenValues, queueEmail } from "../email";
import { logger } from "../logger";
import { message } from "../messages";
import { type PolicyUser, inRequisitionScope } from "../policy/permissions";
import { scopeApplicationsFor } from "../policy/filters";
import { getSetting } from "../settings";

export type InterviewRow = typeof interviews.$inferSelect;
export type InterviewError = "invalid" | "notFound" | "notOpen" | "locked" | "stale" | "notStarted";
export type InterviewResult =
  | { ok: true; interview: InterviewRow; changed: boolean }
  | { ok: false; reason: InterviewError; fields?: Record<string, string> };

/** Q1 (owner decision): who can sit on an interview; Hiring Managers only within V3a scope. */
const PARTICIPANT_ROLES = ["INTERVIEWER", "RECRUITER", "ADMIN"] as const;

const scheduleSchema = z
  .object({
    startLocal: z.string(),
    timezone: z.string(),
    durationMinutes: z.number().int(),
    locationOrLink: z.string(),
    participantIds: z.array(z.string()).max(100),
  })
  .strict();
const updateSchema = scheduleSchema.partial().extend({ expectedSequence: z.number().int().min(0) }).strict();
const sequenceSchema = z.object({ expectedSequence: z.number().int().min(0) }).strict();
const outcomeSchema = z.object({ status: z.enum(["COMPLETED", "NO_SHOW"]) }).strict();

function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") for (const key of issue.keys) fields[key] = "invalid";
    else fields[String(issue.path[0] ?? "_")] ??= "invalid";
  }
  return fields;
}

type ApplicationContext = {
  id: string;
  status: string;
  anonymizedAt: Date | null;
  requisition: { hiringManagerId: string; approverId: string | null; createdByUserId: string; title: string };
};

/**
 * The application `user` may see, locked FOR SHARE so a concurrent status
 * change (FOR UPDATE) waits or is waited for: a final application never
 * gets a new interview (Q2, R12).
 */
async function lockApplication(tx: Tx, user: PolicyUser | null, applicationId: string): Promise<ApplicationContext | undefined> {
  if (!z.uuid().safeParse(applicationId).success) return undefined;
  const [row] = await tx
    .select({
      id: applications.id,
      status: applications.status,
      anonymizedAt: applications.anonymizedAt,
      requisition: {
        hiringManagerId: requisitions.hiringManagerId,
        approverId: requisitions.approverId,
        createdByUserId: requisitions.createdByUserId,
        title: requisitions.title,
      },
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(and(eq(applications.id, applicationId), user ? scopeApplicationsFor(user) : undefined))
    .for("share", { of: applications });
  return row;
}

const isOpen = (application: ApplicationContext) => isOpenStatus(application.status) && application.anonymizedAt === null;

type Timing = { startsAtUtc: Date; durationMinutes: number; timezone: string; locationOrLink: string };

/** I1, Q3, Q7: the timing fields, or the errors by field. `now` refuses past starts. */
function validateTiming(input: { startLocal: string; timezone: string; durationMinutes: number; locationOrLink: string }, now: Date, checkPast: boolean) {
  const fields: Record<string, string> = {};
  let startsAtUtc: Date | undefined;
  if (!isValidTimeZone(input.timezone)) fields.timezone = "timezone";
  else {
    const start = localToUtc(input.startLocal, input.timezone);
    if (!start.ok) fields.startLocal = start.reason === "nonexistent" ? "startNonexistent" : "startInvalid";
    else if (checkPast && start.instant.getTime() <= now.getTime()) fields.startLocal = "startPast";
    else startsAtUtc = start.instant;
  }
  if (input.durationMinutes < MIN_DURATION_MINUTES || input.durationMinutes > MAX_DURATION_MINUTES) fields.durationMinutes = "duration";
  const location = input.locationOrLink.trim();
  if (location.length < 1 || location.length > MAX_LOCATION_LENGTH) fields.locationOrLink = "location";
  const timing: Timing | undefined = startsAtUtc ? { startsAtUtc, durationMinutes: input.durationMinutes, timezone: input.timezone, locationOrLink: location } : undefined;
  return { fields, timing };
}

/**
 * Q1, Q7: 1–10 distinct participants. `toCheck` (all on create, the added
 * ones on an edit) must be active Interviewers, Recruiters or Admins, or
 * Hiring Managers in the requisition's V3a scope. Returns an error code.
 */
async function participantsError(tx: Tx, application: ApplicationContext, ids: readonly string[], toCheck: readonly string[]): Promise<string | undefined> {
  if (ids.length < 1 || ids.length > MAX_PARTICIPANTS) return "participantsCount";
  if (new Set(ids).size !== ids.length) return "participantsDuplicate";
  if (toCheck.some((id) => !z.uuid().safeParse(id).success)) return "participantInvalid";
  if (toCheck.length === 0) return undefined;
  const rows = await tx.select({ id: users.id, role: users.role, isActive: users.isActive }).from(users).where(inArray(users.id, [...toCheck]));
  const eligible = (row: (typeof rows)[number]) =>
    row.isActive &&
    ((PARTICIPANT_ROLES as readonly string[]).includes(row.role) || (row.role === "HIRING_MANAGER" && inRequisitionScope({ id: row.id, role: row.role }, application.requisition)));
  return rows.length === toCheck.length && rows.every(eligible) ? undefined : "participantInvalid";
}

type Recipient = { kind: "candidate" } | { kind: "staff"; userId: string };
type InviteKind = "invite" | "update" | "cancel";

/**
 * Queues one invite email per recipient (I2), each with an `.ics` naming
 * only that recipient. Inactive staff are skipped. Texts are system emails
 * from messages/en.json with the interview tokens (I6: the interview's zone).
 */
async function queueInvites(tx: Tx, interview: InterviewRow, recipients: readonly Recipient[], kind: InviteKind, now: Date): Promise<number> {
  if (recipients.length === 0) return 0;
  const method = kind === "cancel" ? "CANCEL" : "REQUEST";
  const organizerEmail = await getSetting("SENDER_EMAIL", tx);
  const { to: candidateEmail, values } = await buildApplicationTokenValues(tx, interview.applicationId);
  const candidateName = values.CANDIDATE_FULL_NAME ?? "";
  const jobTitle = values.JOB_TITLE ?? "";
  const interviewValues = {
    ...values,
    INTERVIEW_DATETIME: formatInterviewDateTime(interview.startsAtUtc, interview.timezone),
    INTERVIEW_LOCATION: interview.locationOrLink,
  };
  const duration = String(interview.durationMinutes);
  const staffIds = recipients.flatMap((recipient) => (recipient.kind === "staff" ? [recipient.userId] : []));
  const staff = staffIds.length
    ? await tx.select({ id: users.id, name: users.name, email: users.email }).from(users).where(and(inArray(users.id, staffIds), eq(users.isActive, true)))
    : [];
  const link = `${getConfig().auth.url.replace(/\/$/, "")}/applications/${interview.applicationId}`;

  let queued = 0;
  for (const recipient of recipients) {
    const person =
      recipient.kind === "candidate"
        ? candidateEmail && candidateName
          ? { email: candidateEmail, name: candidateName }
          : undefined
        : staff.find((user) => user.id === recipient.userId);
    if (!person) continue;
    const audience = recipient.kind === "candidate" ? "CANDIDATE" : "STAFF";
    const texts = `Email.interview.${kind}.${recipient.kind}`;
    const ics = buildInvite({
      method,
      uid: interview.icsUid,
      sequence: interview.icsSequence,
      startUtc: interview.startsAtUtc,
      durationMinutes: interview.durationMinutes,
      summary: message(`Email.interview.icsSummary.${recipient.kind}`, { job: jobTitle, candidate: candidateName }),
      location: interview.locationOrLink,
      description: message(`Email.interview.icsDescription.${recipient.kind}`, { job: jobTitle, candidate: candidateName, link }),
      organizerEmail,
      attendee: person,
      dtstamp: now,
    });
    await queueEmail(tx, {
      to: person.email,
      audience,
      applicationId: interview.applicationId,
      subject: message(`${texts}.subject`),
      body: message(`${texts}.body`, { duration, link }),
      values: interviewValues,
      ics: { content: ics, method, uid: interview.icsUid, sequence: interview.icsSequence },
    });
    queued += 1;
  }
  return queued;
}

/** The candidate and every current (not removed) participant. */
async function everyone(tx: Tx, interviewId: string): Promise<Recipient[]> {
  const rows = await tx
    .select({ userId: interviewParticipants.userId })
    .from(interviewParticipants)
    .where(and(eq(interviewParticipants.interviewId, interviewId), isNull(interviewParticipants.removedAt)))
    .orderBy(asc(interviewParticipants.createdAt));
  return [{ kind: "candidate" }, ...rows.map((row) => ({ kind: "staff" as const, userId: row.userId }))];
}

/**
 * I1, I2, I8: schedules an interview for an open application and queues
 * the REQUEST to the candidate and each active participant. The
 * application's status, history and version stay as they are.
 */
export async function scheduleInterview(tx: Tx, user: PolicyUser, applicationId: string, input: unknown, now = new Date()): Promise<InterviewResult> {
  const application = await lockApplication(tx, user, applicationId);
  if (!application) return { ok: false, reason: "notFound" };
  if (!isOpen(application)) return { ok: false, reason: "notOpen" };
  const parsed = scheduleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const { fields, timing } = validateTiming(parsed.data, now, true);
  const participants = parsed.data.participantIds;
  const participantError = await participantsError(tx, application, participants, participants);
  if (participantError) fields.participantIds = participantError;
  if (!timing || Object.keys(fields).length > 0) return { ok: false, reason: "invalid", fields };

  const [interview] = await tx
    .insert(interviews)
    .values({ applicationId, ...timing, status: "SCHEDULED", icsUid: `${randomUUID()}@ats`, icsSequence: 0, createdByUserId: user.id })
    .returning();
  await tx.insert(interviewParticipants).values(participants.map((userId) => ({ interviewId: interview.id, userId })));
  const queued = await queueInvites(tx, interview, await everyone(tx, interview.id), "invite", now);
  logger.info({ interview_id: interview.id, application_id: applicationId, user_id: user.id, participants: participants.length, emails: queued }, "interview scheduled");
  return { ok: true, interview, changed: true };
}

/** The interview `user` may see, locked FOR UPDATE, with its application (locked FOR SHARE). */
async function lockInterview(tx: Tx, user: PolicyUser | null, interviewId: string) {
  if (!z.uuid().safeParse(interviewId).success) return undefined;
  const [found] = await tx.select({ applicationId: interviews.applicationId }).from(interviews).where(eq(interviews.id, interviewId));
  if (!found) return undefined;
  // The application first, as the status service locks it (no deadlock with R12).
  const application = await lockApplication(tx, user, found.applicationId);
  if (!application) return undefined;
  const [interview] = await tx.select().from(interviews).where(eq(interviews.id, interviewId)).for("update");
  return { interview, application };
}

async function currentParticipantIds(tx: Tx, interviewId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: interviewParticipants.userId })
    .from(interviewParticipants)
    .where(and(eq(interviewParticipants.interviewId, interviewId), isNull(interviewParticipants.removedAt)))
    .orderBy(asc(interviewParticipants.createdAt));
  return rows.map((row) => row.userId);
}

/**
 * I3, I5: reschedules and/or changes the participants of a SCHEDULED
 * interview at `expectedSequence`. A save that changes nothing sends
 * nothing; otherwise the sequence goes up once. A timing change sends
 * REQUEST to everyone current; added participants get REQUEST, removed
 * ones CANCEL, and nobody else gets mail (Q4).
 */
export async function updateInterview(tx: Tx, user: PolicyUser, interviewId: string, input: unknown, now = new Date()): Promise<InterviewResult> {
  const locked = await lockInterview(tx, user, interviewId);
  if (!locked) return { ok: false, reason: "notFound" };
  const { interview, application } = locked;
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  if (interview.status !== "SCHEDULED") return { ok: false, reason: "locked" };
  if (interview.icsSequence !== parsed.data.expectedSequence) return { ok: false, reason: "stale" };
  if (!isOpen(application)) return { ok: false, reason: "notOpen" };

  const data = parsed.data;
  const timezone = data.timezone ?? interview.timezone;
  const startLocal = data.startLocal ?? utcToLocal(interview.startsAtUtc, interview.timezone);
  const requested = {
    startLocal,
    timezone,
    durationMinutes: data.durationMinutes ?? interview.durationMinutes,
    locationOrLink: data.locationOrLink ?? interview.locationOrLink,
  };
  // A past start is refused only when the start actually moves.
  const probe = validateTiming(requested, now, false);
  const moves = probe.timing !== undefined && probe.timing.startsAtUtc.getTime() !== interview.startsAtUtc.getTime();
  const { fields, timing } = moves ? validateTiming(requested, now, true) : probe;

  const current = await currentParticipantIds(tx, interviewId);
  const next = data.participantIds ?? current;
  const { added, removed } = participantChanges(current, next);
  const participantError = await participantsError(tx, application, next, added);
  if (participantError) fields.participantIds = participantError;
  if (!timing || Object.keys(fields).length > 0) return { ok: false, reason: "invalid", fields };

  const retimed = timingChanged(interview, timing);
  if (!retimed && added.length === 0 && removed.length === 0) return { ok: true, interview, changed: false };

  const [updated] = await tx
    .update(interviews)
    .set({ ...timing, icsSequence: interview.icsSequence + 1, updatedAt: now })
    .where(eq(interviews.id, interviewId))
    .returning();
  if (removed.length > 0) {
    await tx
      .update(interviewParticipants)
      .set({ removedAt: now })
      .where(and(eq(interviewParticipants.interviewId, interviewId), inArray(interviewParticipants.userId, removed)));
  }
  if (added.length > 0) {
    // Re-adding a removed participant clears removed_at on their row.
    await tx
      .insert(interviewParticipants)
      .values(added.map((userId) => ({ interviewId, userId })))
      .onConflictDoUpdate({ target: [interviewParticipants.interviewId, interviewParticipants.userId], set: { removedAt: null } });
  }
  const staff = (ids: string[]): Recipient[] => ids.map((userId) => ({ kind: "staff", userId }));
  let emails = 0;
  emails += retimed
    ? await queueInvites(tx, updated, await everyone(tx, interviewId), "update", now)
    : await queueInvites(tx, updated, staff(added), "invite", now);
  emails += await queueInvites(tx, updated, staff(removed), "cancel", now);
  logger.info(
    { interview_id: interviewId, user_id: user.id, sequence: updated.icsSequence, retimed, added: added.length, removed: removed.length, emails },
    "interview updated",
  );
  return { ok: true, interview: updated, changed: true };
}

/** Sets CANCELLED, increments the sequence and sends CANCEL to everyone current (I4). */
async function cancelLocked(tx: Tx, interview: InterviewRow, now: Date): Promise<{ interview: InterviewRow; emails: number }> {
  const [updated] = await tx
    .update(interviews)
    .set({ status: "CANCELLED", icsSequence: interview.icsSequence + 1, updatedAt: now })
    .where(eq(interviews.id, interview.id))
    .returning();
  const emails = await queueInvites(tx, updated, await everyone(tx, interview.id), "cancel", now);
  return { interview: updated, emails };
}

/** I4: cancels a SCHEDULED interview at `expectedSequence`. */
export async function cancelInterview(tx: Tx, user: PolicyUser, interviewId: string, input: unknown, now = new Date()): Promise<InterviewResult> {
  const locked = await lockInterview(tx, user, interviewId);
  if (!locked) return { ok: false, reason: "notFound" };
  const parsed = sequenceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  if (locked.interview.status !== "SCHEDULED") return { ok: false, reason: "locked" };
  if (locked.interview.icsSequence !== parsed.data.expectedSequence) return { ok: false, reason: "stale" };
  const { interview, emails } = await cancelLocked(tx, locked.interview, now);
  logger.info({ interview_id: interviewId, user_id: user.id, sequence: interview.icsSequence, emails }, "interview cancelled");
  return { ok: true, interview, changed: true };
}

/**
 * I7, Q5: marks COMPLETED or NO_SHOW once the start has passed; the two can
 * be corrected into each other. No email, no sequence change.
 */
export async function markInterviewOutcome(tx: Tx, user: PolicyUser, interviewId: string, input: unknown, now = new Date()): Promise<InterviewResult> {
  const locked = await lockInterview(tx, user, interviewId);
  if (!locked) return { ok: false, reason: "notFound" };
  const parsed = outcomeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const { interview } = locked;
  if (interview.status === "CANCELLED") return { ok: false, reason: "locked" };
  if (interview.status === "SCHEDULED" && interview.startsAtUtc.getTime() > now.getTime()) return { ok: false, reason: "notStarted" };
  if (interview.status === parsed.data.status) return { ok: true, interview, changed: false };
  const [updated] = await tx.update(interviews).set({ status: parsed.data.status, updatedAt: now }).where(eq(interviews.id, interviewId)).returning();
  logger.info({ interview_id: interviewId, user_id: user.id, status: updated.status }, "interview outcome marked");
  return { ok: true, interview: updated, changed: true };
}

/**
 * R12: called by the status service when an application reaches a final
 * status, after R7 cancelled its queued emails (so these CANCELs are sent).
 * Future SCHEDULED interviews are cancelled as in I4; past ones stay for the
 * outcome (Q8). The caller holds the application row FOR UPDATE.
 */
export async function cancelFutureInterviews(tx: Tx, applicationId: string, now = new Date()): Promise<number> {
  const future = await tx
    .select()
    .from(interviews)
    .where(and(eq(interviews.applicationId, applicationId), eq(interviews.status, "SCHEDULED"), gt(interviews.startsAtUtc, now)))
    .orderBy(asc(interviews.startsAtUtc))
    .for("update");
  for (const interview of future) {
    const { emails } = await cancelLocked(tx, interview, now);
    logger.info({ interview_id: interview.id, application_id: applicationId, emails }, "interview cancelled by final status");
  }
  return future.length;
}

export type InterviewListItem = InterviewRow & {
  participants: { userId: string; name: string; isActive: boolean; removed: boolean }[];
};

/** The application page's interviews: upcoming first (soonest first), then past (latest first). */
export async function listApplicationInterviews(applicationId: string, now = new Date(), db: Db | Tx = getDb()): Promise<InterviewListItem[]> {
  const rows = await db.select().from(interviews).where(eq(interviews.applicationId, applicationId));
  if (rows.length === 0) return [];
  const people = await db
    .select({ interviewId: interviewParticipants.interviewId, userId: users.id, name: users.name, isActive: users.isActive, removedAt: interviewParticipants.removedAt })
    .from(interviewParticipants)
    .innerJoin(users, eq(users.id, interviewParticipants.userId))
    .where(inArray(interviewParticipants.interviewId, rows.map((row) => row.id)))
    .orderBy(asc(interviewParticipants.createdAt));
  const upcoming = rows.filter((row) => row.startsAtUtc > now).sort((a, b) => a.startsAtUtc.getTime() - b.startsAtUtc.getTime());
  const past = rows.filter((row) => row.startsAtUtc <= now).sort((a, b) => b.startsAtUtc.getTime() - a.startsAtUtc.getTime());
  return [...upcoming, ...past].map((row) => ({
    ...row,
    participants: people
      .filter((person) => person.interviewId === row.id)
      .map(({ userId, name, isActive, removedAt }) => ({ userId, name, isActive, removed: removedAt !== null })),
  }));
}

/**
 * The participant picker (Q1): active Interviewers, Recruiters and Admins,
 * and the Hiring Managers in the requisition's V3a scope, sorted by name.
 */
export async function listParticipantOptions(applicationId: string, db: Db | Tx = getDb()): Promise<{ id: string; name: string }[]> {
  const [row] = await db
    .select({ hiringManagerId: requisitions.hiringManagerId, approverId: requisitions.approverId, createdByUserId: requisitions.createdByUserId })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(eq(applications.id, applicationId));
  if (!row) return [];
  const active = await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.isActive, true)).orderBy(asc(users.name), asc(users.email));
  return active
    .filter((user) => (PARTICIPANT_ROLES as readonly string[]).includes(user.role) || (user.role === "HIRING_MANAGER" && inRequisitionScope({ id: user.id, role: user.role }, row)))
    .map(({ id, name }) => ({ id, name }));
}

export type MyInterview = {
  id: string;
  startsAtUtc: Date;
  durationMinutes: number;
  status: InterviewRow["status"];
  candidate: string | null;
  jobTitle: string;
  scorecard: "NOT_STARTED" | "DRAFT" | "SUBMITTED" | "REOPENED";
};

/**
 * "My interviews" (task 34, Q6): the non-cancelled interviews where `user`
 * is a current participant and may still read the application (V5 for
 * Interviewers, V3a for Hiring Managers, always for Admins and Recruiters),
 * upcoming first (soonest first), then past (latest first), with the
 * state of the user's own scorecard.
 */
export async function listMyInterviews(user: PolicyUser, now = new Date(), db: Db | Tx = getDb()): Promise<MyInterview[]> {
  const rows = await db
    .select({
      id: interviews.id,
      startsAtUtc: interviews.startsAtUtc,
      durationMinutes: interviews.durationMinutes,
      status: interviews.status,
      firstName: applications.firstName,
      lastName: applications.lastName,
      jobTitle: requisitions.title,
      submittedAt: interviewScorecards.submittedAt,
      reopenedAt: interviewScorecards.reopenedAt,
      scorecardId: interviewScorecards.id,
    })
    .from(interviewParticipants)
    .innerJoin(interviews, eq(interviews.id, interviewParticipants.interviewId))
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .leftJoin(interviewScorecards, and(eq(interviewScorecards.interviewId, interviews.id), eq(interviewScorecards.interviewerId, user.id)))
    .where(and(eq(interviewParticipants.userId, user.id), isNull(interviewParticipants.removedAt), ne(interviews.status, "CANCELLED"), scopeApplicationsFor(user)));
  const upcoming = rows.filter((row) => row.startsAtUtc > now).sort((a, b) => a.startsAtUtc.getTime() - b.startsAtUtc.getTime());
  const past = rows.filter((row) => row.startsAtUtc <= now).sort((a, b) => b.startsAtUtc.getTime() - a.startsAtUtc.getTime());
  return [...upcoming, ...past].map((row) => ({
    id: row.id,
    startsAtUtc: row.startsAtUtc,
    durationMinutes: row.durationMinutes,
    status: row.status,
    candidate: row.firstName && row.lastName ? `${row.firstName} ${row.lastName}` : null,
    jobTitle: row.jobTitle,
    scorecard: !row.scorecardId ? "NOT_STARTED" : row.submittedAt ? "SUBMITTED" : row.reopenedAt ? "REOPENED" : "DRAFT",
  }));
}

/** The edit form's start in the interview's own zone. */
export { utcToLocal };
