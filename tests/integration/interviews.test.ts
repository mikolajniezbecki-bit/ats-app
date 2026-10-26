// Interview scheduling and invites against the database (ats-project-scope.md
// I1–I8, R7, R12; tech-stack.md T5, J1): through the API with real session
// cookies, invites read from Mailpit. Start times are in next year, so they
// stay in the future; past interviews are inserted directly.
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { POST as schedule } from "@/app/api/applications/[id]/interviews/route";
import { PATCH as patchInterview } from "@/app/api/interviews/[id]/route";
import { POST as cancel } from "@/app/api/interviews/[id]/cancel/route";
import { POST as outcome } from "@/app/api/interviews/[id]/outcome/route";
import { jobQueue } from "@/server/adapters/job-queue";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { applicationHistory, applications, emailLog, interviewParticipants, interviews, users } from "@/server/db/schema";
import { changeApplicationStatus } from "@/server/pipeline";
import { getMessage, searchMessages } from "../support/mailpit";
import { processDueJobs } from "../support/process-due-jobs";
import { insertApplication, insertRequisition, insertUser } from "./fixtures";
import { ORIGIN, signedIn } from "./sessions";

type Session = Awaited<ReturnType<typeof signedIn>>;
type Handler = (request: Request, context: never) => Promise<Response>;
const db = () => getDb() as unknown as Tx;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const call = (handler: Handler, method: string, id: string, body: unknown, session?: Session) =>
  handler(
    new Request(`${ORIGIN}/api/x/${id}`, {
      method,
      headers: { ...(session ? { cookie: session.cookie } : {}), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(id),
  );

const YEAR = new Date().getUTCFullYear() + 1;
const STALE = "This record was changed by someone else. Reload and try again.";

// Emails this file queued and didn't send are cancelled, so another file's
// processDueJobs (with its own fake transport) never picks them up.
const createdApplicationIds: string[] = [];
afterAll(async () => {
  if (createdApplicationIds.length === 0) return;
  await withTransaction(async (tx) => {
    const queued = await tx
      .update(emailLog)
      .set({ status: "CANCELLED" })
      .where(and(inArray(emailLog.applicationId, createdApplicationIds), eq(emailLog.status, "QUEUED")))
      .returning({ jobId: emailLog.jobId });
    for (const { jobId } of queued) if (jobId) await jobQueue.cancel(tx, "email.send", jobId);
  });
});

/** An open application on an approved requisition, with a unique candidate email. */
async function openApplication(overrides: Partial<typeof applications.$inferInsert> = {}) {
  const hm = await insertUser(db(), "HIRING_MANAGER");
  const requisition = await insertRequisition(db(), { state: "APPROVED", approvedAt: new Date(), isPublished: true, hiringManagerId: hm.id });
  const application = await insertApplication(db(), { requisitionId: requisition.id, email: `cand-${randomUUID()}@example.com`, ...overrides });
  createdApplicationIds.push(application.id);
  return { application, requisition, hm };
}

function body(participantIds: string[], overrides: Record<string, unknown> = {}) {
  return { startLocal: `${YEAR}-01-15T10:00`, timezone: "Europe/Warsaw", durationMinutes: 60, locationOrLink: "Room 4, Warsaw office", participantIds, ...overrides };
}

async function scheduled(session: Session, applicationId: string, participantIds: string[], overrides: Record<string, unknown> = {}) {
  const response = await call(schedule, "POST", applicationId, body(participantIds, overrides), session);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  return (await response.json()).interview as typeof interviews.$inferSelect;
}

async function interviewRow(id: string) {
  const [row] = await getDb().select().from(interviews).where(eq(interviews.id, id));
  return row;
}

/** Every Mailpit message to `to`, with its .ics unfolded. */
async function invitesTo(to: string) {
  const summaries = await searchMessages(to);
  return Promise.all(
    summaries.map(async (summary) => {
      const message = await getMessage(summary.ID);
      const attachment = message.attachments.find((file) => file.name === "invite.ics");
      const ics = (attachment?.bytes.toString("utf8") ?? "").replace(/\r\n /g, "");
      return { message, ics, attachment };
    }),
  );
}

const icsField = (ics: string, name: string) => ics.split("\r\n").filter((line) => line.startsWith(name));

describe("scheduling", () => {
  it("I1: 10:00 Europe/Warsaw is stored as 09:00Z in winter and 08:00Z in summer, with sequence 0 and the participants", async () => {
    const recruiter = await signedIn("RECRUITER");
    const interviewer = await insertUser(db(), "INTERVIEWER");
    const { application } = await openApplication();
    const winter = await scheduled(recruiter, application.id, [interviewer.id]);
    expect(winter).toMatchObject({ status: "SCHEDULED", icsSequence: 0, durationMinutes: 60, timezone: "Europe/Warsaw", createdByUserId: recruiter.userId });
    expect(new Date(winter.startsAtUtc).toISOString()).toBe(`${YEAR}-01-15T09:00:00.000Z`);
    expect(winter.icsUid).toMatch(/^[0-9a-f-]{36}@ats$/);
    const summer = await scheduled(recruiter, application.id, [interviewer.id], { startLocal: `${YEAR}-07-15T10:00` });
    expect(new Date(summer.startsAtUtc).toISOString()).toBe(`${YEAR}-07-15T08:00:00.000Z`);
    expect(summer.icsUid).not.toBe(winter.icsUid);
    const participants = await getDb().select().from(interviewParticipants).where(eq(interviewParticipants.interviewId, winter.id));
    expect(participants.map((row) => row.userId)).toEqual([interviewer.id]);
    await processDueJobs();
  });

  it("I1: a time in the daylight-saving gap, a past time, a bad zone and out-of-range limits return 400", async () => {
    const recruiter = await signedIn("RECRUITER");
    const interviewer = await insertUser(db(), "INTERVIEWER");
    const { application } = await openApplication();
    const cases: [Record<string, unknown>, Record<string, string>][] = [
      [{ startLocal: `${YEAR}-03-28T02:30` }, { startLocal: "This time doesn't exist in the chosen time zone." }],
      [{ startLocal: `${YEAR - 2}-01-15T10:00` }, { startLocal: "The start time is in the past." }],
      [{ timezone: "Mars/Olympus" }, { timezone: "Choose a valid time zone." }],
      [{ durationMinutes: 10 }, { durationMinutes: "Enter 15 to 480 minutes." }],
      [{ durationMinutes: 481 }, { durationMinutes: "Enter 15 to 480 minutes." }],
      [{ locationOrLink: "  " }, { locationOrLink: "Enter 1 to 500 characters." }],
      [{ participantIds: [] }, { participantIds: "Choose 1 to 10 participants." }],
      [{ participantIds: [interviewer.id, interviewer.id] }, { participantIds: "Each participant can be chosen only once." }],
    ];
    for (const [overrides, fields] of cases) {
      const response = await call(schedule, "POST", application.id, body([interviewer.id], overrides), recruiter);
      expect(response.status).toBe(400);
      expect((await response.json()).fields).toEqual(fields);
    }
    expect(await getDb().select().from(interviews).where(eq(interviews.applicationId, application.id))).toEqual([]);
  });

  it("I1: participants are active Interviewers, Recruiters, Admins or in-scope Hiring Managers (Q1)", async () => {
    const recruiter = await signedIn("RECRUITER");
    const { application, hm } = await openApplication();
    const inactive = await insertUser(db(), "INTERVIEWER");
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, inactive.id));
    const outsideHm = await insertUser(db(), "HIRING_MANAGER");
    for (const id of [inactive.id, outsideHm.id, randomUUID()]) {
      const response = await call(schedule, "POST", application.id, body([id]), recruiter);
      expect(response.status).toBe(400);
      expect(Object.keys((await response.json()).fields)).toEqual(["participantIds"]);
    }
    const panel = [hm.id, (await insertUser(db(), "RECRUITER")).id, (await insertUser(db(), "ADMIN")).id, (await insertUser(db(), "INTERVIEWER")).id];
    await scheduled(recruiter, application.id, panel);
    await processDueJobs();
  });

  it("I2: the candidate and each participant get their own email whose .ics lists only them, as text/calendar and invite.ics", async () => {
    const recruiter = await signedIn("RECRUITER");
    const first = await insertUser(db(), "INTERVIEWER");
    const second = await insertUser(db(), "INTERVIEWER");
    const { application } = await openApplication();
    const interview = await scheduled(recruiter, application.id, [first.id, second.id]);
    await processDueJobs();

    for (const to of [application.email!, first.email, second.email]) {
      const received = await invitesTo(to);
      expect(received).toHaveLength(1);
      const [{ message, ics, attachment }] = received;
      expect(attachment).toBeDefined();
      expect(message.raw).toMatch(/Content-Type: text\/calendar;[^\r\n]*method=REQUEST/i);
      expect(icsField(ics, "ATTENDEE")).toHaveLength(1);
      expect(icsField(ics, "ATTENDEE")[0]).toMatch(new RegExp(`:mailto:${to.replace(/[.+]/g, "\\$&")}$`));
      expect(icsField(ics, "ORGANIZER")[0]).toMatch(/:mailto:careers@ats-demo\.local$/);
      expect(icsField(ics, "UID")).toEqual([`UID:${interview.icsUid}`]);
      expect(icsField(ics, "SEQUENCE")).toEqual(["SEQUENCE:0"]);
    }
    const [candidate] = await invitesTo(application.email!);
    expect(candidate.message.subject).toBe("Interview invitation: Backend Engineer");
    const [staff] = await invitesTo(first.email);
    expect(staff.message.text).toContain(`/applications/${application.id}`);
  });

  it("I2: a participant deactivated after being picked gets nothing on the next invite; the others still do", async () => {
    const recruiter = await signedIn("RECRUITER");
    const active = await insertUser(db(), "INTERVIEWER");
    const leaver = await insertUser(db(), "INTERVIEWER");
    const { application } = await openApplication();
    const interview = await scheduled(recruiter, application.id, [active.id, leaver.id]);
    await getDb().update(emailLog).set({ status: "CANCELLED" }).where(eq(emailLog.applicationId, application.id));
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, leaver.id));
    const response = await call(patchInterview, "PATCH", interview.id, { expectedSequence: 0, durationMinutes: 45 }, recruiter);
    expect(response.status).toBe(200);
    const logged = await getDb().select({ recipient: emailLog.recipient }).from(emailLog).where(and(eq(emailLog.applicationId, application.id), eq(emailLog.status, "QUEUED")));
    expect(logged.map((row) => row.recipient).sort()).toEqual([application.email!, active.email].sort());
    await processDueJobs();
    expect(await invitesTo(leaver.email)).toEqual([]);
  });

  it("I8: scheduling leaves the application's status, version and history unchanged", async () => {
    const recruiter = await signedIn("RECRUITER");
    const { application } = await openApplication({ status: "SCREENING" });
    const history = () => getDb().select().from(applicationHistory).where(eq(applicationHistory.applicationId, application.id));
    const before = await history();
    await scheduled(recruiter, application.id, [(await insertUser(db(), "INTERVIEWER")).id]);
    const [after] = await getDb().select().from(applications).where(eq(applications.id, application.id));
    expect(after).toMatchObject({ status: "SCREENING", version: application.version });
    expect(await history()).toEqual(before);
  });

  it("I1: only open, not anonymized applications get interviews; HM and Interviewer 403, no session 401, unknown 404", async () => {
    const recruiter = await signedIn("RECRUITER");
    const interviewer = await insertUser(db(), "INTERVIEWER");
    for (const overrides of [{ status: "REJECTED" as const }, { anonymizedAt: new Date() }]) {
      const { application } = await openApplication(overrides);
      const response = await call(schedule, "POST", application.id, body([interviewer.id]), recruiter);
      expect(response.status).toBe(409);
      expect((await response.json()).message).toBe("Interviews can be scheduled only for open applications.");
    }
    const { application } = await openApplication();
    expect((await call(schedule, "POST", application.id, body([interviewer.id]), await signedIn("HIRING_MANAGER"))).status).toBe(403);
    expect((await call(schedule, "POST", application.id, body([interviewer.id]), await signedIn("INTERVIEWER"))).status).toBe(403);
    expect((await call(schedule, "POST", application.id, body([interviewer.id]))).status).toBe(401);
    expect((await call(schedule, "POST", randomUUID(), body([interviewer.id]), recruiter)).status).toBe(404);
    expect((await call(patchInterview, "PATCH", randomUUID(), { expectedSequence: 0 }, recruiter)).status).toBe(404);
  });
});

describe("changes", () => {
  it("I3: rescheduling sends REQUEST with the same UID and SEQUENCE:1 to every current recipient; a no-op save sends nothing", async () => {
    const recruiter = await signedIn("RECRUITER");
    const interviewer = await insertUser(db(), "INTERVIEWER");
    const { application } = await openApplication();
    const interview = await scheduled(recruiter, application.id, [interviewer.id]);
    await processDueJobs();

    const same = await call(patchInterview, "PATCH", interview.id, { expectedSequence: 0, locationOrLink: interview.locationOrLink }, recruiter);
    expect((await same.json()).changed).toBe(false);
    expect((await interviewRow(interview.id)).icsSequence).toBe(0);

    const moved = await call(patchInterview, "PATCH", interview.id, { expectedSequence: 0, startLocal: `${YEAR}-01-16T11:30` }, recruiter);
    expect(moved.status).toBe(200);
    expect(await interviewRow(interview.id)).toMatchObject({ icsSequence: 1, icsUid: interview.icsUid, startsAtUtc: new Date(`${YEAR}-01-16T10:30:00Z`) });
    await processDueJobs();
    for (const to of [application.email!, interviewer.email]) {
      const received = await invitesTo(to);
      expect(received).toHaveLength(2);
      const update = received.find(({ ics }) => ics.includes("SEQUENCE:1"))!;
      expect(icsField(update.ics, "METHOD")).toEqual(["METHOD:REQUEST"]);
      expect(icsField(update.ics, "UID")).toEqual([`UID:${interview.icsUid}`]);
      expect(icsField(update.ics, "DTSTART")).toEqual([`DTSTART:${YEAR}0116T103000Z`]);
    }

    const stale = await call(patchInterview, "PATCH", interview.id, { expectedSequence: 0, durationMinutes: 30 }, recruiter);
    expect(stale.status).toBe(409);
    expect((await stale.json()).message).toBe(STALE);
  });

  it("I4: cancelling sends CANCEL with the same UID and SEQUENCE:2; a cancelled interview can't be changed", async () => {
    const recruiter = await signedIn("RECRUITER");
    const interviewer = await insertUser(db(), "INTERVIEWER");
    const { application } = await openApplication();
    const interview = await scheduled(recruiter, application.id, [interviewer.id]);
    expect((await call(patchInterview, "PATCH", interview.id, { expectedSequence: 0, durationMinutes: 30 }, recruiter)).status).toBe(200);
    expect((await call(cancel, "POST", interview.id, { expectedSequence: 0 }, recruiter)).status).toBe(409);
    expect((await call(cancel, "POST", interview.id, { expectedSequence: 1 }, recruiter)).status).toBe(200);
    expect(await interviewRow(interview.id)).toMatchObject({ status: "CANCELLED", icsSequence: 2, icsUid: interview.icsUid });
    await processDueJobs();
    for (const to of [application.email!, interviewer.email]) {
      const cancelled = (await invitesTo(to)).find(({ ics }) => ics.includes("METHOD:CANCEL"))!;
      expect(cancelled.message.raw).toMatch(/Content-Type: text\/calendar;[^\r\n]*method=CANCEL/i);
      expect(icsField(cancelled.ics, "SEQUENCE")).toEqual(["SEQUENCE:2"]);
      expect(icsField(cancelled.ics, "UID")).toEqual([`UID:${interview.icsUid}`]);
      expect(icsField(cancelled.ics, "STATUS")).toEqual(["STATUS:CANCELLED"]);
    }
    const locked = await call(patchInterview, "PATCH", interview.id, { expectedSequence: 2, durationMinutes: 45 }, recruiter);
    expect(locked.status).toBe(409);
    expect((await locked.json()).message).toBe("This interview can no longer be changed.");
    expect((await call(cancel, "POST", interview.id, { expectedSequence: 2 }, recruiter)).status).toBe(409);
  });

  it("I5: an added participant gets REQUEST and a removed one CANCEL, with the next sequence and the original UID; nobody else gets mail", async () => {
    const recruiter = await signedIn("RECRUITER");
    const stays = await insertUser(db(), "INTERVIEWER");
    const leaves = await insertUser(db(), "INTERVIEWER");
    const joins = await insertUser(db(), "INTERVIEWER");
    const { application } = await openApplication();
    const interview = await scheduled(recruiter, application.id, [stays.id, leaves.id]);
    await processDueJobs();

    const response = await call(patchInterview, "PATCH", interview.id, { expectedSequence: 0, participantIds: [stays.id, joins.id] }, recruiter);
    expect(response.status).toBe(200);
    expect((await interviewRow(interview.id)).icsSequence).toBe(1);
    await processDueJobs();
    const [joined] = await invitesTo(joins.email);
    expect(icsField(joined.ics, "METHOD")).toEqual(["METHOD:REQUEST"]);
    expect(icsField(joined.ics, "SEQUENCE")).toEqual(["SEQUENCE:1"]);
    expect(icsField(joined.ics, "UID")).toEqual([`UID:${interview.icsUid}`]);
    const left = (await invitesTo(leaves.email)).find(({ ics }) => ics.includes("METHOD:CANCEL"))!;
    expect(icsField(left.ics, "SEQUENCE")).toEqual(["SEQUENCE:1"]);
    expect(icsField(left.ics, "UID")).toEqual([`UID:${interview.icsUid}`]);
    expect(await invitesTo(stays.email)).toHaveLength(1);
    expect(await invitesTo(application.email!)).toHaveLength(1);

    const rows = await getDb().select().from(interviewParticipants).where(eq(interviewParticipants.interviewId, interview.id)).orderBy(asc(interviewParticipants.createdAt));
    expect(rows.find((row) => row.userId === leaves.id)?.removedAt).toBeInstanceOf(Date);
    // Re-adding clears removed_at on the same row (unique interview + user).
    expect((await call(patchInterview, "PATCH", interview.id, { expectedSequence: 1, participantIds: [stays.id, joins.id, leaves.id] }, recruiter)).status).toBe(200);
    const again = await getDb().select().from(interviewParticipants).where(and(eq(interviewParticipants.interviewId, interview.id), eq(interviewParticipants.userId, leaves.id)));
    expect(again).toHaveLength(1);
    expect(again[0].removedAt).toBeNull();
    await processDueJobs();
  });
});

describe("display and outcome", () => {
  it("I6: an interview at 14:00 America/New_York shows that time with its zone in the email and UTC in the .ics", async () => {
    const recruiter = await signedIn("RECRUITER");
    const interviewer = await insertUser(db(), "INTERVIEWER");
    const { application } = await openApplication();
    await scheduled(recruiter, application.id, [interviewer.id], { startLocal: `${YEAR}-01-15T14:00`, timezone: "America/New_York" });
    await processDueJobs();
    const [{ message, ics }] = await invitesTo(application.email!);
    expect(message.text).toContain("14:00 (America/New_York)");
    expect(icsField(ics, "DTSTART")).toEqual([`DTSTART:${YEAR}0115T190000Z`]);
  });

  it("I7: a past interview can be marked COMPLETED or NO_SHOW and corrected; a future one can't (409); no email is sent", async () => {
    const recruiter = await signedIn("RECRUITER");
    const { application } = await openApplication();
    const [past] = await getDb()
      .insert(interviews)
      .values({ applicationId: application.id, startsAtUtc: new Date(Date.now() - 3 * 3_600_000), durationMinutes: 60, timezone: "Europe/Warsaw", locationOrLink: "Room 1", icsUid: `${randomUUID()}@ats`, createdByUserId: recruiter.userId })
      .returning();
    const future = await scheduled(recruiter, application.id, [(await insertUser(db(), "INTERVIEWER")).id]);
    const queued = async () => (await getDb().select().from(emailLog).where(eq(emailLog.applicationId, application.id))).length;
    const emailsBefore = await queued();

    const early = await call(outcome, "POST", future.id, { status: "COMPLETED" }, recruiter);
    expect(early.status).toBe(409);
    expect((await call(outcome, "POST", past.id, { status: "COMPLETED" }, recruiter)).status).toBe(200);
    expect((await interviewRow(past.id)).status).toBe("COMPLETED");
    expect((await call(outcome, "POST", past.id, { status: "NO_SHOW" }, recruiter)).status).toBe(200);
    expect(await interviewRow(past.id)).toMatchObject({ status: "NO_SHOW", icsSequence: 0 });
    expect((await call(patchInterview, "PATCH", past.id, { expectedSequence: 0, durationMinutes: 30 }, recruiter)).status).toBe(409);
    expect(await queued()).toBe(emailsBefore);
  });
});

describe("final status", () => {
  it("R12: rejecting cancels the future SCHEDULED interview with sequence + 1 and CANCEL emails; the past one stays", async () => {
    const recruiter = await signedIn("RECRUITER");
    const interviewer = await insertUser(db(), "INTERVIEWER");
    const { application } = await openApplication({ status: "INTERVIEW" });
    const future = await scheduled(recruiter, application.id, [interviewer.id]);
    const [past] = await getDb()
      .insert(interviews)
      .values({ applicationId: application.id, startsAtUtc: new Date(Date.now() - 3_600_000), durationMinutes: 30, timezone: "UTC", locationOrLink: "Call", icsUid: `${randomUUID()}@ats`, createdByUserId: recruiter.userId })
      .returning();

    const result = await withTransaction((tx) => changeApplicationStatus(tx, { applicationId: application.id, toStatus: "REJECTED", version: application.version, actor: { id: recruiter.userId } }));
    expect(result.ok).toBe(true);
    expect(await interviewRow(future.id)).toMatchObject({ status: "CANCELLED", icsSequence: 1 });
    expect((await interviewRow(past.id)).status).toBe("SCHEDULED");

    // R7: the original invites were still queued and are cancelled; the CANCELs are sent.
    const logged = await getDb().select().from(emailLog).where(eq(emailLog.applicationId, application.id));
    expect(logged.filter((row) => row.icsSequence === 0).every((row) => row.status === "CANCELLED")).toBe(true);
    await processDueJobs();
    for (const to of [application.email!, interviewer.email]) {
      const received = await invitesTo(to);
      expect(received).toHaveLength(1);
      expect(icsField(received[0].ics, "METHOD")).toEqual(["METHOD:CANCEL"]);
      expect(icsField(received[0].ics, "SEQUENCE")).toEqual(["SEQUENCE:1"]);
    }
  });
});
