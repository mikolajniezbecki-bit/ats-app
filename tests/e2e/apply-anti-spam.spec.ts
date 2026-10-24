// Apply anti-spam on the Compose stack (ats-project-scope.md F6; tech-stack.md
// §3 rule 9): the rate limit with x-enforce-rate-limit and a per-test
// x-forwarded-for (no proxy runs in front of the Compose app, so the last
// entry is the test's), the honeypot, a missing Turnstile token, and the CSP.
import { randomInt } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";
import { fillApplication, newCandidate, waitForTurnstile } from "./support/apply";
import { query } from "./support/db";
import { insertRequisition } from "./support/requisitions";

const live = { state: "APPROVED" as const, approved: true, isPublished: true };
const randomIp = () => `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;

/** Sends the rate-limit headers on this app's apply requests only (not to Cloudflare). */
async function asClient(page: Page, ip: string) {
  await page.route("**/apply/**", (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-enforce-rate-limit": "true", "x-forwarded-for": ip } }),
  );
}

async function countFor(email: string) {
  return (await query<{ count: string }>("SELECT count(*) FROM applications WHERE email = $1", [email]))[0].count;
}

test("F6: with x-enforce-rate-limit, the sixth submission from one IP within an hour is refused; another IP is accepted", async ({ page }) => {
  test.setTimeout(120_000);
  const job = await insertRequisition(live);
  const ip = randomIp();
  await asClient(page, ip);
  for (let i = 1; i <= 5; i++) {
    const candidate = newCandidate();
    await page.goto(`/apply/${job.id}`);
    await (await fillApplication(page, candidate)).getByRole("button", { name: "Submit application" }).click();
    await expect(page.getByRole("heading", { name: "Thank you" }), `submission ${i}`).toBeVisible();
  }
  const sixth = newCandidate();
  await page.goto(`/apply/${job.id}`);
  const form = await fillApplication(page, sixth);
  await form.getByRole("button", { name: "Submit application" }).click();
  await expect(form.getByRole("alert")).toHaveText("Too many applications from your network. Please try again later.");
  expect(await countFor(sixth.email)).toBe("0");

  await page.unrouteAll();
  await asClient(page, randomIp());
  await page.goto(`/apply/${job.id}`);
  await (await fillApplication(page, sixth)).getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
});

test("F6: a filled honeypot refuses the submission without creating an application or a file", async ({ page }) => {
  const job = await insertRequisition(live);
  const candidate = newCandidate();
  await page.goto(`/apply/${job.id}`);
  const form = await fillApplication(page, candidate);
  const honeypot = page.locator('input[name="website"]');
  await expect(honeypot).toHaveAttribute("tabindex", "-1");
  await expect(honeypot).toHaveAttribute("autocomplete", "off");
  await honeypot.evaluate((input: HTMLInputElement) => (input.value = "https://spam.example"));
  await form.getByRole("button", { name: "Submit application" }).click();
  await expect(form.getByRole("alert")).toHaveText("Your application could not be submitted. Please try again.");
  expect(await countFor(candidate.email)).toBe("0");
  const [files] = await query<{ count: string }>(
    "SELECT count(*) FROM files f JOIN applications a ON a.id = f.owner_id WHERE a.requisition_id = $1",
    [job.id],
  );
  expect(files.count).toBe("0");
});

test("F6: a submission without a Turnstile token is refused, and the widget gives a new token for the next try", async ({ page }) => {
  const job = await insertRequisition(live);
  const candidate = newCandidate();
  await page.goto(`/apply/${job.id}`);
  const form = await fillApplication(page, candidate);
  await page.locator('input[name="cf-turnstile-response"]').evaluate((input: HTMLInputElement) => input.remove());
  await form.getByRole("button", { name: "Submit application" }).click();
  await expect(form.getByRole("alert")).toHaveText("Please complete the verification and try again.");
  expect(await countFor(candidate.email)).toBe("0");

  // The widget was reset after the refusal, so the same form now goes through.
  await waitForTurnstile(page);
  await form.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
});

test("F6: the apply page loads Turnstile without CSP violations; the widget renders", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to (load|execute|frame)/i.test(message.text())) violations.push(message.text());
  });
  const job = await insertRequisition(live);
  const response = await page.goto(`/apply/${job.id}`);
  expect(response?.headers()["content-security-policy"]).toContain("https://challenges.cloudflare.com");
  await expect(page.getByTestId("turnstile")).toBeVisible();
  // The widget renders its iframe in a closed shadow root; its token in the form shows it ran.
  await waitForTurnstile(page);
  expect(violations).toEqual([]);
});
