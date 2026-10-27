// The hire export on the Compose stack (ats-project-scope.md §5.6 Hire
// export, V10): the demo Recruiter opens /exports and downloads the CSV with
// a hired candidate's row; a Hiring Manager gets the 403 page. Other specs
// share the database, so the test finds its own row by application ID.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { insertApplication } from "./support/applications";
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";
import { ROLES } from "./support/users";

const HEADER = "Application ID,Requisition number,First name,Last name,Email,Phone,Job title,Department,Location,Legal entity,Start date,Salary,Currency,Hired date";

test("V10: a Recruiter downloads the hire CSV from /exports; a Hiring Manager gets 403", async ({ asRole }) => {
  const word = `Export${randomUUID().slice(0, 8)}`;
  const job = await insertRequisition({ title: `Data Engineer ${word}`, state: "APPROVED", approved: true, isPublished: true });
  const application = await insertApplication(job.id, { status: "HIRED" });
  await query("UPDATE applications SET hired_at = now(), dispositioned_at = now() WHERE id = $1", [application.id]);
  const [template] = await query<{ id: string }>("SELECT id FROM templates WHERE type = 'OFFER' AND name = 'Default offer letter'");
  const [hm] = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ROLES["hiring-manager"].email]);
  await query(
    `INSERT INTO offers (application_id, template_id, created_by_user_id, job_title, salary, currency, start_date,
       approval_status, approver_id, candidate_response, sent_at, responded_at)
     VALUES ($1, $2, $3, $4, 85000, 'EUR', '2027-01-15', 'APPROVED', $3, 'ACCEPTED', now(), now())`,
    [application.id, template.id, hm.id, `Data Engineer ${word}`],
  );

  const recruiter = await asRole("recruiter");
  await recruiter.goto("/dashboard");
  await recruiter.getByRole("link", { name: "Exports" }).click();
  await expect(recruiter.getByRole("heading", { name: "Hire export" })).toBeVisible();
  const form = recruiter.getByRole("form", { name: "Hire export" });
  // Include already exported: a parallel spec's default export may have taken this hire first.
  await form.getByLabel("Include already exported").check();
  const [download] = await Promise.all([recruiter.waitForEvent("download"), form.getByRole("button", { name: "Export hires" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^hires-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = (await readFile((await download.path())!)).toString("utf8");
  expect(text.startsWith("﻿")).toBe(true);
  const lines = text.slice(1).split("\r\n");
  expect(lines[0]).toBe(HEADER);
  const warsawToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(new Date());
  // The seeded location label has a comma, so it is quoted (RFC 4180); the phone keeps its leading `+`.
  expect(lines).toContain(
    [application.id, job.reqNumber, application.firstName, application.lastName, application.email, "+00 600 100 200", `Data Engineer ${word}`, "Engineering", '"Warsaw, Poland"', "ATS Demo Polska Sp. z o.o.", "2027-01-15", "85000.00", "EUR", warsawToday].join(","),
  );
  const [row] = await query<{ exported_at: Date | null }>("SELECT exported_at FROM applications WHERE id = $1", [application.id]);
  expect(row.exported_at).not.toBeNull();

  const hmPage = await asRole("hiring-manager");
  const response = await hmPage.goto("/exports");
  expect(response?.status()).toBe(403);
  await expect(hmPage.getByRole("link", { name: "Exports" })).toHaveCount(0);
});
