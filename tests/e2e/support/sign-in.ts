import { type Page, expect } from "@playwright/test";

/** Signs in through the /sign-in form (AU7) and waits for the dashboard. */
export async function signInThroughForm(page: Page, email: string, password: string, path = "/sign-in"): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}
