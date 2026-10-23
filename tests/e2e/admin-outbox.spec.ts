// The Admin Outbox and jobs page (tech-stack.md §9, J6, T5; Sprint 0 proof
// #8, local part): a captured email with its body, .ics and PDF.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { createCapturedEmail, insertLoggedEmail } from "./support/emails";

function cspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  return violations;
}

test("V1: an Admin opens a captured email with its body, .ics and PDF attachment (proof #8)", async ({ asRole }, testInfo) => {
  const email = createCapturedEmail();
  const page = await asRole("admin");
  const violations = cspViolations(page);

  await page.goto("/admin/outbox?status=CAPTURED");
  const row = page.getByTestId(`outbox-${email.emailLogId}`);
  await expect(row).toContainText(email.to);
  await expect(row).toContainText("Captured");
  await page.screenshot({ path: testInfo.outputPath("outbox-list.png"), fullPage: true });

  await row.getByRole("link", { name: "Your interview" }).click();
  await expect(page.getByRole("heading", { name: "Email" })).toBeVisible();
  const frame = page.getByTitle("Email body");
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  const body = page.frameLocator('iframe[title="Email body"]');
  await expect(body.getByRole("heading", { name: "Interview invitation" })).toBeVisible();
  await expect(body.getByText("Reply to this email to reach your recruiter.")).toBeVisible();
  const logo = body.getByRole("img", { name: "Logo" });
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("outbox-detail.png"), fullPage: true });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download invite (.ics)" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`invite-${email.emailLogId}.ics`);
  expect(readFileSync((await download.path())!, "utf8").startsWith("BEGIN:VCALENDAR")).toBe(true);

  const popupPromise = page.waitForEvent("popup");
  const pdfResponse = page.context().waitForEvent("response", (response) => response.url().includes(`/devstoreaccount1/files/`));
  await page.getByRole("button", { name: "Open Offer letter.pdf" }).click();
  await popupPromise;
  const pdf = await pdfResponse;
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");

  expect(violations).toEqual([]);
});

test("the sandboxed body runs no script and fetches no remote image", async ({ asRole }) => {
  const scripted = await insertLoggedEmail('<p id="before">Text</p><script>document.title = "pwned"; parent.document.title = "pwned";</script>');
  const remote = await insertLoggedEmail('<p>Image</p><img src="https://example.com/x.png" alt="remote">');
  const page = await asRole("admin");
  const external: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://example.com")) external.push(request.url());
  });

  await page.goto(`/admin/outbox/${scripted}`);
  await expect(page.frameLocator('iframe[title="Email body"]').locator("#before")).toHaveText("Text");
  await page.waitForTimeout(300);
  expect(await page.title()).not.toBe("pwned");

  await page.goto(`/admin/outbox/${remote}`);
  await expect(page.frameLocator('iframe[title="Email body"]').getByText("Image")).toBeVisible();
  await page.waitForTimeout(300);
  expect(external).toEqual([]);
});

test("V1: an Admin sees the queues and the daily-task runs", async ({ asRole }) => {
  const page = await asRole("admin");
  await page.goto("/admin");
  await page.getByRole("main").getByRole("link", { name: "Background jobs" }).click();
  await expect(page.getByRole("heading", { name: "Background jobs" })).toBeVisible();
  for (const queue of ["email.send", "offer.render-pdf", "approvals.remind", "retention.purge"]) {
    await expect(page.getByTestId(`queue-${queue}`)).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Daily-task runs (last 30 days)" })).toBeVisible();
});

for (const role of ["recruiter", "hiring-manager", "interviewer"] as const) {
  test(`AU9: ${role} gets HTTP 403 on the Outbox, a message, the jobs page and the .ics route`, async ({ asRole }) => {
    const id = await insertLoggedEmail("<p>x</p>");
    const page = await asRole(role);
    for (const path of ["/admin/outbox", `/admin/outbox/${id}`, "/admin/jobs"]) {
      expect((await page.goto(path))?.status(), path).toBe(403);
    }
    expect((await page.request.get(`/api/admin/outbox/${id}/ics`)).status()).toBe(403);
  });
}
