// `asRole(role)` opens a page signed in as one of the four shared e2e users,
// from the state the setup project saved (T4).
import { rm } from "node:fs/promises";
import { type Page, test as base } from "@playwright/test";
import type { RoleKey } from "./users";

export const authFile = (role: RoleKey) => `tests/e2e/.auth/${role}.json`;

export const test = base.extend<{ asRole: (role: RoleKey) => Promise<Page> }>({
  // Playwright's `video` option records only the contexts it creates itself,
  // so these contexts record their own (T6, task 43): kept and attached to the
  // report when the test fails, deleted when it passes (retain-on-failure).
  asRole: async ({ browser, baseURL, video }, provide, testInfo) => {
    const mode = typeof video === "string" ? video : video.mode;
    const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    const videoDir = testInfo.outputPath("role-videos");
    await provide(async (role) => {
      const context = await browser.newContext({
        baseURL,
        storageState: authFile(role),
        ...(mode === "off" ? {} : { recordVideo: { dir: videoDir } }),
      });
      contexts.push(context);
      return context.newPage();
    });
    const pages = contexts.flatMap((context) => context.pages());
    // Closing finalizes the video files.
    for (const context of contexts) await context.close();
    if (mode === "off") return;
    if (testInfo.status === testInfo.expectedStatus) {
      await rm(videoDir, { recursive: true, force: true });
      return;
    }
    for (const [i, page] of pages.entries()) {
      const path = await page.video()?.path();
      if (path) await testInfo.attach(`video ${i + 1}`, { path, contentType: "video/webm" });
    }
    // attach() copied them into the test's attachments.
    await rm(videoDir, { recursive: true, force: true });
  },
});

export { expect } from "@playwright/test";
