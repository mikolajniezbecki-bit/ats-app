// Steps the role journeys share (tech-stack.md §11, task 46). Each one drives
// the real UI; specs create their own data with unique titles (T2).
import { randomUUID } from "node:crypto";
import { type Page, expect } from "@playwright/test";
import { query } from "./db";
import { ROLES } from "./users";

export const live = { state: "APPROVED", approved: true, isPublished: true } as const;

/** A word no other test uses, for finding this test's job on the board. */
export const uniqueWord = (prefix: string) => `${prefix}${randomUUID().replaceAll("-", "").slice(0, 10)}`;

export const userId = async (email: string) => (await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]))[0].id;

export async function changeStatus(page: Page, label: string, comment?: string) {
  const form = page.getByRole("form", { name: "Change status" });
  await form.getByLabel("New status").selectOption({ label });
  if (comment !== undefined) await form.getByLabel(/^Comment/).fill(comment);
  await form.getByRole("button", { name: "Change status" }).click();
  await expect(form.getByRole("status")).toHaveText(`Status changed to ${label.replace(/ \(reopen\)$/, "")}.`);
}

/** Creates a one-opening requisition through the form; returns its ID and number. */
export async function createRequisition(page: Page, title: string) {
  await page.goto("/requisitions/new");
  const form = page.getByRole("form", { name: "New requisition" });
  await form.getByLabel("Template").selectOption({ label: "Standard requisition" });
  await form.getByLabel("Job title").fill(title);
  await form.getByLabel("Department").selectOption({ label: "Engineering" });
  await form.getByLabel("Location").selectOption({ label: "Warsaw, Poland" });
  await form.getByLabel("Legal entity").selectOption({ label: "ATS Demo Polska Sp. z o.o." });
  await form.getByLabel("Hiring manager").selectOption({ label: ROLES["hiring-manager"].name });
  await form.getByLabel("Recruiter").selectOption({ label: ROLES.recruiter.name });
  await form.getByLabel("Openings").fill("1");
  await form.getByLabel("Employment type").selectOption({ label: "Full-time" });
  await form.getByRole("textbox", { name: "Description" }).fill("A job created by a role journey.");
  await form.getByRole("button", { name: "Save requisition" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`^REQ-\\d{5} · ${title}$`) })).toBeVisible();
  const [row] = await query<{ id: string; req_number: string }>("SELECT id, req_number FROM requisitions WHERE title = $1", [title]);
  return { id: row.id, reqNumber: row.req_number, title };
}

export async function submitRequisition(page: Page, requisitionId: string, approverName: string) {
  await page.goto(`/requisitions/${requisitionId}`);
  await page.getByRole("button", { name: "Submit for approval" }).click();
  const form = page.getByRole("form", { name: "Submit for approval" });
  await form.getByLabel("Approver").selectOption({ label: approverName });
  await form.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByTestId("approval-status")).toContainText(`Awaiting approval by ${approverName}`);
}

export async function approveRequisition(page: Page, requisitionId: string) {
  await page.goto(`/requisitions/${requisitionId}`);
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("form", { name: "Approve" }).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("approval-latest")).toContainText("Latest decision: Approved by");
}

/** An offer in DRAFT, created through the form on the application page; returns its ID. */
export async function createOffer(page: Page, applicationId: string, salary = "85000") {
  const start = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const offers = page.getByTestId("offers");
  await offers.getByRole("button", { name: "Create offer" }).click();
  const form = page.getByRole("form", { name: "Create offer" });
  await form.getByLabel("Gross annual salary").fill(salary);
  await form.getByLabel("Start date").fill(start);
  await form.getByRole("button", { name: "Create offer" }).click();
  await expect(offers.getByRole("button", { name: "Submit for approval" })).toBeVisible();
  const [offer] = await query<{ id: string }>("SELECT id FROM offers WHERE application_id = $1", [applicationId]);
  return offer.id;
}

export async function submitOffer(page: Page, offerId: string, approverName: string) {
  await page.getByTestId(`offer-${offerId}`).getByRole("button", { name: "Submit for approval" }).click();
  const form = page.getByRole("form", { name: "Submit for approval" });
  await form.getByLabel("Approver").selectOption({ label: approverName });
  await form.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByTestId(`offer-approval-${offerId}`)).toContainText(`Awaiting approval by ${approverName}`);
}

/** An interview that has already started, so scorecards can be filled in (I9), with its participants. */
export async function insertStartedInterview(applicationId: string, participantIds: string[]) {
  const creator = await userId(ROLES.recruiter.email);
  const [interview] = await query<{ id: string }>(
    `INSERT INTO interviews (application_id, starts_at_utc, duration_minutes, timezone, location_or_link, ics_uid, created_by_user_id)
     VALUES ($1, now() - interval '2 hours', 60, 'Europe/Warsaw', 'Room 9', $2, $3) RETURNING id`,
    [applicationId, `${randomUUID()}@ats`, creator],
  );
  for (const id of participantIds) await query("INSERT INTO interview_participants (interview_id, user_id) VALUES ($1, $2)", [interview.id, id]);
  return interview.id;
}
