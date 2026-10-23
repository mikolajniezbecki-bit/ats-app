// A disqualified application (ats-project-scope.md §5.3 On submit, E8, R11;
// tech-stack.md T3): the candidate sees the same thank-you page, and the
// rejection email waits REJECTION_EMAIL_DELAY_HOURS. The tick moves the
// clock 25 hours ahead; the spec asserts only on its own application.
import { expect, test } from "@playwright/test";
import { waitForMessage, searchMessages } from "../../support/mailpit";
import { fillApplication, newCandidate } from "../support/apply";
import { query } from "../support/db";
import { E2E_TICK_SECRET } from "../support/env";
import { insertQuestion, insertRequisition } from "../support/requisitions";

test("a disqualifying answer (E8 on creation) gives the thank-you page, a REJECTED application and a rejection email after the delay", async ({ page, request }) => {
  const job = await insertRequisition({ state: "APPROVED", approved: true, isPublished: true });
  await insertQuestion(job.id, { text: "Do you have a driving licence?", type: "YES_NO", disqualifying: "NO" });
  const candidate = newCandidate();
  await page.goto(`/apply/${job.id}`);
  const form = await fillApplication(page, candidate);
  await form.getByRole("group", { name: "Do you have a driving licence?" }).getByLabel("No").check();
  await form.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByText("Thank you for applying. We've sent a confirmation to your email address if one is configured.")).toBeVisible();

  const [application] = await query<{ id: string; status: string; reason_code: string; is_disqualified: boolean; dispositioned_at: Date | null }>(
    "SELECT id, status, reason_code, is_disqualified, dispositioned_at FROM applications WHERE email = $1",
    [candidate.email],
  );
  expect(application).toMatchObject({ status: "REJECTED", reason_code: "DISQUALIFIED", is_disqualified: true });
  expect(application.dispositioned_at).not.toBeNull();
  const [email] = await query<{ status: string; scheduled_for: Date }>("SELECT status, scheduled_for FROM email_log WHERE application_id = $1", [application.id]);
  expect(email.status).toBe("QUEUED");
  const hours = (new Date(email.scheduled_for).getTime() - Date.now()) / 3_600_000;
  expect(hours).toBeGreaterThan(23.5);
  expect(hours).toBeLessThanOrEqual(24);
  expect(await searchMessages(candidate.email)).toEqual([]);

  const response = await request.post("/api/internal/tick", {
    headers: { "x-tick-secret": E2E_TICK_SECRET, "x-test-now": new Date(Date.now() + 25 * 3_600_000).toISOString() },
    timeout: 200_000,
  });
  expect(response.status()).toBe(200);
  await waitForMessage({ to: candidate.email, timeoutMs: 15_000 });
});
