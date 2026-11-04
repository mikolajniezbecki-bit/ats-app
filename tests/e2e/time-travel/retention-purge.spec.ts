// The retention purge on the Compose stack (ats-project-scope.md §5.8 RT3,
// F8, task 40 Q5; tech-stack.md T2, T3): a Recruiter rejects an application;
// a tick years ahead runs retention.purge, and the application page shows
// the anonymized applicant without files or a status control. The tick date
// is random within 2045–2049, beyond the 10-year maximum RETENTION_DAYS, so
// a rerun against the same database gets its own date (a job_runs row blocks
// its date). The purge acts on the whole database; the spec asserts only on
// its own application.
import { expect, test } from "../support/fixtures";
import { insertApplication } from "../support/applications";
import { query } from "../support/db";
import { E2E_TICK_SECRET } from "../support/env";
import { insertRequisition } from "../support/requisitions";

function randomTickDate(): string {
  const day = new Date(Date.UTC(2045, 0, 1) + Math.floor(Math.random() * 5 * 365) * 86_400_000);
  return `${day.toISOString().slice(0, 10)}T09:00:00Z`;
}

test("RT3: after a tick past the retention period a rejected application shows 'Anonymized applicant', no CV and no status control", async ({ asRole, request }) => {
  // The tick waits for the purge, which anonymizes every expired application in the shared
  // database (with its blobs); on a long-lived local stack that can take well over the default 30 s.
  test.setTimeout(240_000);
  const job = await insertRequisition({ state: "APPROVED", approved: true, isPublished: true });
  const application = await insertApplication(job.id, { status: "SCREENING" });
  const recruiter = await asRole("recruiter");
  await recruiter.goto(`/applications/${application.id}`);
  await expect(recruiter.getByTestId("document-CV")).toBeVisible();
  const status = recruiter.getByRole("form", { name: "Change status" });
  await status.getByLabel("New status").selectOption({ label: "Rejected" });
  await status.getByRole("button", { name: "Change status" }).click();
  await expect(status.getByRole("status")).toHaveText("Status changed to Rejected.");

  const response = await request.post("/api/internal/tick", {
    headers: { "x-tick-secret": E2E_TICK_SECRET, "x-test-now": randomTickDate() },
    timeout: 200_000,
  });
  expect(response.status()).toBe(200);
  const [row] = await query<{ anonymized_at: Date | null; first_name: string | null }>("SELECT anonymized_at, first_name FROM applications WHERE id = $1", [application.id]);
  expect(row.anonymized_at).not.toBeNull();
  expect(row.first_name).toBeNull();

  await recruiter.reload();
  await expect(recruiter.getByRole("heading", { level: 1 })).toHaveText("Anonymized applicant");
  await expect(recruiter.getByText(application.lastName)).toHaveCount(0);
  await expect(recruiter.getByText("Removed under the retention policy")).toBeVisible();
  await expect(recruiter.getByTestId("document-CV")).toHaveCount(0);
  await expect(recruiter.getByRole("form", { name: "Change status" })).toHaveCount(0);

  // The purge journey (task 46): an Admin sees the same result, and the CV is deleted (the row stays, without its name).
  const admin = await asRole("admin");
  await admin.goto(`/applications/${application.id}`);
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("Anonymized applicant");
  await expect(admin.getByTestId("document-CV")).toHaveCount(0);
  const files = await query<{ deleted_at: Date | null; original_name: string | null }>("SELECT deleted_at, original_name FROM files WHERE owner_id = $1 AND owner_type = 'APPLICATION'", [application.id]);
  expect(files).toHaveLength(1);
  expect(files[0].deleted_at).not.toBeNull();
  expect(files[0].original_name).toBeNull();
});
