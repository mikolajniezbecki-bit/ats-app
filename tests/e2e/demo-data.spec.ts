// The synthetic demo data on the Compose stack (tech-stack.md D8; task 42):
// after `node db/seed.mjs` on a fresh stack, each demo role finds something
// to do. The seeded approvals and interviews belong to the seeded demo users
// (hm@, interviewer@ + DEMO_USER_DOMAIN), not the e2e users, so those two
// sign in through the form. Assertions use the seeded titles, never row
// counts (T2).
import type { Browser, Page } from "@playwright/test";
import { query } from "./support/db";
import { demoUser } from "./support/env";
import { expect, test } from "./support/fixtures";
import { signInThroughForm } from "./support/sign-in";

const BLOB_ORIGIN = "http://localhost:10000";

async function asDemoUser(browser: Browser, baseURL: string | undefined, localPart: "hm" | "interviewer"): Promise<Page> {
  const page = await (await browser.newContext({ baseURL })).newPage();
  const { email, password } = demoUser(localPart);
  await signInThroughForm(page, email, password);
  return page;
}

test("D8: the seeded SCREENING application's CV opens inline; the Hiring Manager has approvals; the Interviewer has a scorecard to fill", async ({ asRole, browser, baseURL }) => {
  const [screening] = await query<{ id: string }>(
    `SELECT a.id FROM applications a JOIN requisitions r ON r.id = a.requisition_id
     WHERE r.title = 'Backend Engineer (synthetic)' AND a.status = 'SCREENING' AND a.anonymized_at IS NULL LIMIT 1`,
  );
  expect(screening, "run the seed on a fresh stack first (node db/seed.mjs)").toBeDefined();
  const recruiter = await asRole("recruiter");
  const pdf = recruiter.waitForResponse((response) => response.url().startsWith(`${BLOB_ORIGIN}/devstoreaccount1/files/`));
  await recruiter.goto(`/applications/${screening.id}`);
  await expect(recruiter.getByRole("heading", { level: 1 })).toHaveText(/ (Sample|Example|Placeholder|Testcase|Demo)$/);
  await expect(recruiter.getByTitle("CV", { exact: true })).toHaveAttribute("src", new RegExp(`^${BLOB_ORIGIN}/devstoreaccount1/files/.+[?&]sig=`));
  expect((await pdf).status()).toBe(200);

  const hm = await asDemoUser(browser, baseURL, "hm");
  await hm.goto("/approvals");
  await expect(hm.getByText("Finance Controller (synthetic)")).toBeVisible();
  await expect(hm.getByText("Sales Representative (synthetic)")).toBeVisible();
  await expect(hm.getByRole("region", { name: "Offers" })).toContainText("Backend Engineer");

  const interviewer = await asDemoUser(browser, baseURL, "interviewer");
  await interviewer.goto("/interviews");
  const row = interviewer.getByRole("row").filter({ hasText: "Backend Engineer (synthetic)" }).filter({ hasText: "Scorecard: Not started" });
  await expect(row.first()).toBeVisible();
});
