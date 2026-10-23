// Quick Apply on the Compose stack (ats-project-scope.md §5.3, F2, F7, E8).
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { waitForMessage } from "../support/mailpit";
import { fillApplication, newCandidate } from "./support/apply";
import { query } from "./support/db";
import { insertQuestion, insertRequisition } from "./support/requisitions";

const live = { state: "APPROVED" as const, approved: true, isPublished: true };

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(", ")}`)).toEqual([]);
}

async function applicationFor(email: string) {
  const rows = await query<{ id: string; status: string; source: string; consent_version: string; consent_accepted_at: Date | null; prescreen_score: number }>(
    "SELECT id, status, source, consent_version, consent_accepted_at, prescreen_score FROM applications WHERE email = $1",
    [email],
  );
  return rows;
}

test("a candidate applies to an external job from the board; the application is APPLIED and acknowledged", async ({ page }) => {
  const word = `z${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const job = await insertRequisition({ ...live, title: `Support Engineer ${word}` });
  await insertQuestion(job.id, { text: "Do you have a work permit?", type: "YES_NO", weight: 10, scoring: "YES", sortOrder: 0 });
  await insertQuestion(job.id, { text: "Anything else?", type: "TEXT", sortOrder: 1 });
  const candidate = newCandidate();

  await page.goto(`/jobs?q=${word}`);
  await page.getByRole("link", { name: job.title }).click();
  await page.getByRole("link", { name: "Apply now" }).click();
  await expect(page.getByRole("heading", { name: `Apply for ${job.title}` })).toBeVisible();
  await expectAccessible(page);

  const form = await fillApplication(page, candidate);
  await form.getByRole("group", { name: "Do you have a work permit?" }).getByLabel("Yes").check();
  await form.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
  await expect(page.getByText("Thank you for applying. We've sent a confirmation to your email address if one is configured.")).toBeVisible();
  await expectAccessible(page);

  const [setting] = await query<{ value: string }>("SELECT value FROM settings WHERE key = 'PRIVACY_STATEMENT_VERSION'");
  const [application] = await applicationFor(candidate.email);
  expect(application).toMatchObject({ status: "APPLIED", source: "CAREER_SITE", consent_version: setting?.value ?? "1.0", prescreen_score: 10 });
  expect(application.consent_accepted_at).not.toBeNull();
  const [cv] = await query<{ kind: string }>("SELECT kind FROM files WHERE owner_id = $1 AND owner_type = 'APPLICATION'", [application.id]);
  expect(cv.kind).toBe("CV");
  const message = await waitForMessage({ to: candidate.email, timeoutMs: 15_000 });
  expect(message.subject).toContain(job.title);

  // A refresh of the thank-you page doesn't submit again.
  await page.reload();
  expect(await applicationFor(candidate.email)).toHaveLength(1);
});

test("the same flow through a private link records PRIVATE_LINK", async ({ page }) => {
  const job = await insertRequisition({ ...live, postingType: "PRIVATE" });
  const candidate = newCandidate();
  await page.goto(`/jobs/p/${job.privateSlug}`);
  await page.getByRole("link", { name: "Apply now" }).click();
  await expect(page).toHaveURL(new RegExp(`/apply/p/${job.privateSlug}$`));
  const form = await fillApplication(page, candidate);
  await form.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
  expect((await applicationFor(candidate.email))[0].source).toBe("PRIVATE_LINK");
  expect((await page.goto(`/apply/${job.id}`))?.status()).toBe(404);
});

test("F7: a second application within 24 hours shows the duplicate message", async ({ page }) => {
  const job = await insertRequisition(live);
  const candidate = newCandidate();
  await page.goto(`/apply/${job.id}`);
  await (await fillApplication(page, candidate)).getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();

  await page.goto(`/apply/${job.id}`);
  const form = await fillApplication(page, { ...candidate, email: ` ${candidate.email.toUpperCase()} ` });
  await form.getByRole("button", { name: "Submit application" }).click();
  await expect(form.getByRole("alert")).toHaveText("You have already applied for this position.");
  expect(await applicationFor(candidate.email)).toHaveLength(1);
});

test("missing answers and fields are shown next to their fields, with no axe violations", async ({ page }) => {
  const job = await insertRequisition(live);
  await insertQuestion(job.id, { text: "Can you relocate?", type: "YES_NO" });
  await page.goto(`/apply/${job.id}`);
  const form = page.getByRole("form", { name: "Application form" });
  await form.getByRole("button", { name: "Submit application" }).click();
  await expect(form.getByText("Enter your first name (1 to 100 characters).")).toBeVisible();
  await expect(form.getByText("Choose your CV as a PDF file.")).toBeVisible();
  await expect(form.getByText("Please confirm that you have read the privacy statement.")).toBeVisible();
  await expect(form.getByLabel("First name")).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page);
});

test("an unpublished job shows the closed message and no form", async ({ page }) => {
  const job = await insertRequisition({ ...live, isPublished: false, state: "ON_HOLD" });
  await page.goto(`/apply/${job.id}`);
  await expect(page.getByText("This position is no longer accepting applications.")).toBeVisible();
  await expect(page.getByRole("form", { name: "Application form" })).toHaveCount(0);
});

test.describe("with MAX_UPLOAD_MB = 1", () => {
  test.describe.configure({ mode: "serial" });
  let previous: string | undefined;
  test.beforeAll(async () => {
    previous = (await query<{ value: string }>("SELECT value FROM settings WHERE key = 'MAX_UPLOAD_MB'"))[0]?.value;
    await query("INSERT INTO settings (key, value) VALUES ('MAX_UPLOAD_MB', '1') ON CONFLICT (key) DO UPDATE SET value = '1'");
  });
  test.afterAll(async () => {
    if (previous === undefined) await query("DELETE FROM settings WHERE key = 'MAX_UPLOAD_MB'");
    else await query("UPDATE settings SET value = $1 WHERE key = 'MAX_UPLOAD_MB'", [previous]);
  });

  const twoMiB = () => {
    const bytes = Buffer.alloc(2 * 1_048_576, 0x20);
    Buffer.from("%PDF-1.4\n").copy(bytes);
    return { name: "big.pdf", mimeType: "application/pdf", buffer: bytes };
  };

  test("F2: the browser refuses a 2 MiB PDF and sends no request", async ({ page }) => {
    const job = await insertRequisition(live);
    const candidate = newCandidate();
    await page.goto(`/apply/${job.id}`);
    const form = await fillApplication(page, candidate);
    await form.getByLabel("CV (PDF)").setInputFiles(twoMiB());
    await expect(form.getByText("The file is larger than 1 MB.")).toBeVisible();
    let posted = false;
    page.on("request", (request) => {
      if (request.method() === "POST") posted = true;
    });
    await form.getByRole("button", { name: "Submit application" }).click();
    await page.waitForTimeout(500);
    expect(posted).toBe(false);
    expect(await applicationFor(candidate.email)).toHaveLength(0);
  });

  test("F2: skipping the browser check, the server refuses the file as too large", async ({ page }) => {
    const job = await insertRequisition(live);
    const candidate = newCandidate();
    await page.goto(`/apply/${job.id}`);
    const form = await fillApplication(page, candidate);
    // Replace the file without a change event, so the browser check never runs.
    await form.getByLabel("CV (PDF)").evaluate((input: HTMLInputElement) => {
      const bytes = new Uint8Array(2 * 1_048_576).fill(0x20);
      bytes.set(new TextEncoder().encode("%PDF-1.4\n"));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "big.pdf", { type: "application/pdf" }));
      input.files = transfer.files;
    });
    await form.getByRole("button", { name: "Submit application" }).click();
    await expect(form.getByText("The file is larger than 1 MB.")).toBeVisible();
    expect(await applicationFor(candidate.email)).toHaveLength(0);
  });
});
