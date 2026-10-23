// Admin user management (ats-project-scope.md §5.1; tech-stack.md AU5, T4,
// T5). Every spec works on its own throwaway user, never the shared e2e users.
import { randomUUID } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { signInThroughForm } from "./support/sign-in";
import { createThrowawayUser, ensureDevUser } from "./support/users";

async function signedInPage(browser: Browser, baseURL: string | undefined, email: string, password: string): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signInThroughForm(page, email, password);
  return page;
}

test("V1: an Admin creates a Recruiter in the UI who can then sign in", async ({ asRole, browser, baseURL }) => {
  const admin = await asRole("admin");
  const email = `e2e-${randomUUID()}@example.com`;
  await admin.goto("/admin");
  await admin.getByRole("main").getByRole("link", { name: "Users" }).click();
  const form = admin.getByRole("form", { name: "Add user" });
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Name").fill("E2E Created Recruiter");
  await form.getByLabel("Role").selectOption("RECRUITER");
  await form.getByRole("button", { name: "Add user" }).click();
  await expect(admin.getByTestId(`user-${email}`)).toContainText("Recruiter");

  // There is no password UI; test support gives the created user one (T4).
  const { password } = ensureDevUser({ email, name: "E2E Created Recruiter", role: "RECRUITER" });
  const page = await signedInPage(browser, baseURL, email, password);
  await page.goto("/dashboard");
  await expect(page.getByTestId("header-user-role")).toHaveText("Recruiter");
  await page.context().close();
});

test("a role change applies on the user's next page load", async ({ asRole, browser, baseURL }) => {
  const user = createThrowawayUser("RECRUITER");
  const page = await signedInPage(browser, baseURL, user.email, user.password);
  await page.goto("/dashboard");
  await expect(page.getByTestId("header-user-role")).toHaveText("Recruiter");

  const admin = await asRole("admin");
  await admin.goto("/admin/users");
  const row = admin.getByTestId(`user-${user.email}`);
  await row.getByLabel("Role").selectOption("HIRING_MANAGER");
  await row.getByRole("button", { name: "Change role" }).click();
  await expect(row).toContainText("Hiring Manager");

  await page.reload();
  await expect(page.getByTestId("header-user-role")).toHaveText("Hiring Manager");
  await page.context().close();
});

test("AU5: a deactivated user is signed out on the next request and refused at sign-in; reactivation lets them back in", async ({
  asRole,
  browser,
  baseURL,
}) => {
  const user = createThrowawayUser("RECRUITER");
  const page = await signedInPage(browser, baseURL, user.email, user.password);
  await page.goto("/dashboard");
  await expect(page.getByTestId("header-user-name")).toHaveText(user.name);

  const admin = await asRole("admin");
  await admin.goto("/admin/users");
  await admin.getByTestId(`user-${user.email}`).getByRole("button", { name: "Deactivate" }).click();
  await expect(admin.getByTestId(`user-${user.email}`)).toHaveCount(0);

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await page.request.get("/api/users/picker")).status()).toBe(401);

  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Access not granted, contact your ATS admin.")).toBeVisible();

  await admin.goto("/admin/users?status=inactive");
  await admin.getByTestId(`user-${user.email}`).getByRole("button", { name: "Reactivate" }).click();
  await expect(admin.getByTestId(`user-${user.email}`)).toHaveCount(0);
  await signInThroughForm(page, user.email, user.password);
  await page.goto("/dashboard");
  await expect(page.getByTestId("header-user-name")).toHaveText(user.name);
  await page.context().close();
});

test("AU9: a Recruiter gets HTTP 403 on /admin/users", async ({ asRole }) => {
  const page = await asRole("recruiter");
  expect((await page.goto("/admin/users"))?.status()).toBe(403);
});
