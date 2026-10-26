// Interviews on the Compose stack (ats-project-scope.md I1–I7): a Recruiter
// schedules an interview with the demo Interviewer and reschedules it, and
// both invites carry the same calendar UID; staff see times in their
// browser's zone (I6).
import { randomUUID } from "node:crypto";
import { getMessage, searchMessages, waitForMessage } from "../support/mailpit";
import { insertApplication } from "./support/applications";
import { query } from "./support/db";
import { authFile, expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";
import { ROLES } from "./support/users";

const YEAR = new Date().getUTCFullYear() + 1;
const uidOf = (ics: string) => /^UID:(.+)$/m.exec(ics.replace(/\r\n /g, ""))?.[1]?.trim();

test("I3: a Recruiter schedules an interview with the Interviewer, reschedules it, and both invites have the same UID", async ({ asRole }) => {
  const requisition = await insertRequisition({ state: "APPROVED", approved: true, isPublished: true });
  const application = await insertApplication(requisition.id);
  const recruiter = await asRole("recruiter");
  await recruiter.goto(`/applications/${application.id}`);

  await recruiter.getByRole("button", { name: "Schedule interview" }).click();
  const form = recruiter.getByRole("form", { name: "Schedule interview" });
  await form.getByLabel("Date and start time").fill(`${YEAR}-02-10T10:00`);
  await form.getByLabel("Time zone").selectOption("Europe/Warsaw");
  await form.getByLabel("Duration (minutes)").fill("45");
  await form.getByLabel("Location or meeting link").fill("https://meet.example.com/abc");
  await form.getByLabel(ROLES.interviewer.name).check();
  await form.getByRole("button", { name: "Schedule" }).click();
  const section = recruiter.getByRole("region", { name: "Interviews" });
  await expect(section.getByText("https://meet.example.com/abc")).toBeVisible();
  await expect(section.getByText(`Participants: ${ROLES.interviewer.name}`)).toBeVisible();

  await section.getByRole("button", { name: "Edit" }).click();
  const edit = recruiter.getByRole("form", { name: "Edit" });
  await expect(edit.getByLabel("Date and start time")).toHaveValue(`${YEAR}-02-10T10:00`);
  await edit.getByLabel("Date and start time").fill(`${YEAR}-02-11T15:30`);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);

  const [interview] = await query<{ ics_uid: string; ics_sequence: number; starts_at_utc: Date }>(
    "SELECT ics_uid, ics_sequence, starts_at_utc FROM interviews WHERE application_id = $1",
    [application.id],
  );
  expect(interview.ics_sequence).toBe(1);
  expect(new Date(interview.starts_at_utc).toISOString()).toBe(`${YEAR}-02-11T14:30:00.000Z`);

  const candidateName = `${application.firstName} ${application.lastName}`;
  await waitForMessage({ to: ROLES.interviewer.email, subjectIncludes: `Interview updated: ${candidateName}`, timeoutMs: 20_000 });
  const mine = (await searchMessages(ROLES.interviewer.email)).filter((summary) => summary.Subject.includes(candidateName));
  expect(mine).toHaveLength(2);
  const uids = await Promise.all(
    mine.map(async (summary) => uidOf((await getMessage(summary.ID)).attachments.find((file) => file.name === "invite.ics")!.bytes.toString("utf8"))),
  );
  expect(uids).toEqual([interview.ics_uid, interview.ics_uid]);
});

test("I6, I7: an interview at 14:00 America/New_York shows 20:00 in a Warsaw browser; a past one awaits its outcome until marked", async ({ browser, baseURL }) => {
  const requisition = await insertRequisition({ state: "APPROVED", approved: true, isPublished: true });
  const application = await insertApplication(requisition.id);
  const [recruiter] = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ROLES.recruiter.email]);
  const insert = (startsAt: Date, timezone: string) =>
    query(
      `INSERT INTO interviews (application_id, starts_at_utc, duration_minutes, timezone, location_or_link, ics_uid, created_by_user_id)
       VALUES ($1, $2, 60, $3, 'Room 7', $4, $5)`,
      [application.id, startsAt, timezone, `${randomUUID()}@ats`, recruiter.id],
    );
  // 14:00 in New York on 15 January is 19:00Z, 20:00 in Warsaw.
  await insert(new Date(`${YEAR}-01-15T19:00:00Z`), "America/New_York");
  await insert(new Date(Date.now() - 3 * 3_600_000), "Europe/Warsaw");

  const context = await browser.newContext({ baseURL, storageState: authFile("recruiter"), timezoneId: "Europe/Warsaw", locale: "en-GB" });
  const page = await context.newPage();
  await page.goto(`/applications/${application.id}`);
  const section = page.getByRole("region", { name: "Interviews" });
  await expect(section.getByText(`15 Jan ${YEAR}, 20:00`)).toBeVisible();

  const past = section.getByRole("listitem").filter({ hasText: "Awaiting outcome" });
  await expect(past).toHaveCount(1);
  await past.getByRole("button", { name: "Completed" }).click();
  await expect(section.getByText("Awaiting outcome")).toHaveCount(0);
  await context.close();
});
