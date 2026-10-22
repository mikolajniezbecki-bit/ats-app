// T4: makes sure the four shared e2e users exist with a fresh random
// password, signs each in through /sign-in and saves the state for asRole().
import { test as setup } from "@playwright/test";
import { authFile } from "./support/fixtures";
import { signInThroughForm } from "./support/sign-in";
import { ROLES, type RoleKey, ensureDevUser } from "./support/users";

for (const [key, user] of Object.entries(ROLES) as [RoleKey, (typeof ROLES)[RoleKey]][]) {
  setup(`sign in as ${key}`, async ({ page }) => {
    const { email, password } = ensureDevUser(user);
    await signInThroughForm(page, email, password);
    await page.context().storageState({ path: authFile(key) });
  });
}
