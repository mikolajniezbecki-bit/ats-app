// `asRole(role)` opens a page signed in as one of the four shared e2e users,
// from the state the setup project saved (T4).
import { type Page, test as base } from "@playwright/test";
import type { RoleKey } from "./users";

export const authFile = (role: RoleKey) => `tests/e2e/.auth/${role}.json`;

export const test = base.extend<{ asRole: (role: RoleKey) => Promise<Page> }>({
  asRole: async ({ browser, baseURL }, provide) => {
    const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    await provide(async (role) => {
      const context = await browser.newContext({ baseURL, storageState: authFile(role) });
      contexts.push(context);
      return context.newPage();
    });
    for (const context of contexts) await context.close();
  },
});

export { expect } from "@playwright/test";
