// Inline PDF viewing on the Compose stack (ats-project-scope.md F5, V11;
// tech-stack.md §8, Sprint 0 proof #7, local part): the CSP allows only the
// browser-facing Blob origin in frame-src, the iframe loads the PDF straight
// from Azurite, and app pages log no CSP violation.
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { storeTestPdf } from "./support/files";

const BLOB_ORIGIN = "http://localhost:10000";

/** Collects console messages that report a CSP violation. */
function cspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  return violations;
}

test("F5: a Recruiter views a PDF inline from the Blob origin under the restrictive CSP", async ({ asRole }) => {
  const fileId = storeTestPdf();
  const page = await asRole("recruiter");
  const violations = cspViolations(page);

  const pdfResponse = page.waitForResponse((response) => response.url().startsWith(`${BLOB_ORIGIN}/devstoreaccount1/files/`));
  const response = await page.goto(`/files/${fileId}`);
  expect(response?.status()).toBe(200);
  const headers = response!.headers();
  expect(headers["content-security-policy"]).toContain(`frame-src ${BLOB_ORIGIN};`);
  expect(headers["content-security-policy"]).not.toContain("azurite");
  expect(headers["x-content-type-options"]).toBe("nosniff");

  const iframe = page.getByTitle("PDF document");
  await expect(iframe).toHaveAttribute("src", new RegExp(`^${BLOB_ORIGIN}/devstoreaccount1/files/`));
  const pdf = await pdfResponse;
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  await expect(page.getByRole("link", { name: "Open in new tab" })).toHaveAttribute("href", /^http:\/\/localhost:10000\//);
  expect(violations).toEqual([]);
});

test("F5: app pages log no CSP violation", async ({ asRole, browser, baseURL }) => {
  const fileId = storeTestPdf();
  const page = await asRole("admin");
  const violations = cspViolations(page);
  // The session keep-alive keeps the network busy, so pages are waited for
  // by their heading after the load event, not by network idle.
  for (const [path, heading] of [
    [`/files/${fileId}`, "Document"],
    ["/dashboard", "Dashboard"],
    ["/admin", "Administration"],
  ]) {
    const response = await page.goto(path, { waitUntil: "load" });
    expect(response?.status(), path).toBe(200);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }

  const anonymous = await browser.newContext({ baseURL });
  const signInPage = await anonymous.newPage();
  const signInViolations = cspViolations(signInPage);
  await signInPage.goto("/sign-in", { waitUntil: "load" });
  await expect(signInPage.getByRole("button", { name: "Sign in" })).toBeVisible();
  await anonymous.close();

  expect([...violations, ...signInViolations]).toEqual([]);
});

// Since task 34 Hiring Managers and Interviewers view files of applications in
// their scope (V4, V5); this file belongs to none of theirs, so it is 404 (V9).
test("V11: the file-link API gives a Recruiter a URL and Hiring Managers and Interviewers outside its application 404", async ({ asRole }) => {
  const fileId = storeTestPdf();

  const recruiter = await asRole("recruiter");
  const ok = await recruiter.request.get(`/api/files/${fileId}/url`);
  expect(ok.status()).toBe(200);
  expect(ok.headers()["cache-control"]).toBe("no-store");
  const { url } = (await ok.json()) as { url: string };
  expect(url.startsWith(`${BLOB_ORIGIN}/devstoreaccount1/files/`)).toBe(true);

  for (const role of ["hiring-manager", "interviewer"] as const) {
    const denied = await (await asRole(role)).request.get(`/api/files/${fileId}/url`);
    expect(denied.status(), role).toBe(404);
    expect(await denied.text()).not.toContain("http");
  }
});
