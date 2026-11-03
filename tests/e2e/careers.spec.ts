// Public career pages on the Compose stack (ats-project-scope.md §5.2
// Postings, §5.3, §8 Accessibility): the board, job pages, private postings,
// sitemap and robots, axe (WCAG 2.1 A/AA) and a 375 px viewport.
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import { insertRequisition } from "./support/requisitions";

const tag = () => `z${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const live = { state: "APPROVED" as const, approved: true, isPublished: true };

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(", ")}`)).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test("the app's bare address opens the public job board", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(page.getByRole("heading", { level: 1, name: "Open positions" })).toBeVisible();
  await expect(page.getByText("coming soon")).toHaveCount(0);
});

test("the board lists a published external job, search narrows it, and a job page shows it with Apply", async ({ page }) => {
  const word = tag();
  const job = await insertRequisition({ ...live, title: `Platform Engineer ${word}`, descriptionHtml: `<p>Kubernetes and ${word}.</p>` });
  const hidden = await insertRequisition({ ...live, isPublished: false, state: "ON_HOLD", title: `Platform Engineer ${word} hold` });
  await page.goto(`/jobs?q=${word}`);
  await expect(page.getByTestId("job-listing")).toHaveCount(1);
  await expect(page.getByRole("link", { name: job.title })).toBeVisible();
  await expect(page.getByText(hidden.title)).toHaveCount(0);
  await expectAccessible(page);

  await page.getByRole("searchbox", { name: "Keywords" }).fill(`${word} nomatch${tag()}`);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No positions match your search.")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/jobs$/);

  await page.goto(`/jobs?q=${word}`);
  await page.getByRole("link", { name: job.title }).click();
  await expect(page).toHaveTitle(`${job.title} | Careers`);
  await expect(page.getByRole("heading", { level: 1, name: job.title })).toBeVisible();
  await expect(page.locator("article header p")).toContainText("Engineering");
  await expect(page.locator("article header p")).toContainText("Warsaw, Poland");
  await expect(page.getByRole("link", { name: "Apply now" })).toHaveAttribute("href", `/apply/${job.id}`);
  await expectAccessible(page);
});

test("an unpublished job shows the closed message only, with noindex", async ({ page }) => {
  const job = await insertRequisition({ ...live, isPublished: false, state: "ON_HOLD", descriptionHtml: "<p>Secret plan</p>" });
  await page.goto(`/jobs/${job.id}`);
  await expect(page.getByText("This position is no longer accepting applications.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Apply now" })).toHaveCount(0);
  await expect(page.getByText("Secret plan")).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expectAccessible(page);
});

test("a private posting opens by slug with noindex and no-referrer, and is in neither the list, a search nor the sitemap", async ({ page, request }) => {
  const job = await insertRequisition({ ...live, postingType: "PRIVATE", title: `Internal Controller ${tag()}` });
  const response = await page.goto(`/jobs/p/${job.privateSlug}`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
  await expect(page.getByRole("link", { name: "Apply now" })).toHaveAttribute("href", `/apply/p/${job.privateSlug}`);
  await expectAccessible(page);

  await page.goto(`/jobs?q=${encodeURIComponent(job.title)}`);
  await expect(page.getByText("No positions match your search.")).toBeVisible();
  const sitemap = await (await request.get("/sitemap.xml")).text();
  expect(sitemap).not.toContain(job.id);
  expect(sitemap).not.toContain("/jobs/p/");
  expect((await page.goto(`/jobs/${job.id}`))?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This job can't be found." })).toBeVisible();
});

test("drafts and unknown jobs are 404; a stored script in the description never reaches the page", async ({ page }) => {
  const draft = await insertRequisition();
  expect((await page.goto(`/jobs/${draft.id}`))?.status()).toBe(404);
  expect((await page.goto(`/jobs/${randomUUID()}`))?.status()).toBe(404);
  expect((await page.goto("/jobs/p/notaslug"))?.status()).toBe(404);

  const job = await insertRequisition({ ...live, descriptionHtml: '<p>Hello</p><script>window.__xss = 1</script><img src="x" onerror="window.__xss = 2">' });
  await page.goto(`/jobs/${job.id}`);
  await expect(page.getByText("Hello")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator("article img, article script").count()).toBe(0);
});

test("sitemap.xml lists external jobs as absolute URLs and robots.txt names it, both without a session", async ({ request }) => {
  const job = await insertRequisition(live);
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(await sitemap.text()).toContain(`http://localhost:3000/jobs/${job.id}`);
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const text = await robots.text();
  for (const path of ["/apply/", "/jobs/p/", "/api/", "/admin", "/dashboard", "/requisitions", "/approvals"]) expect(text).toContain(`Disallow: ${path}`);
  expect(text).toContain("Sitemap: http://localhost:3000/sitemap.xml");
});

test.describe("on a 375 px phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the board, a job page, a closed job and a private job don't scroll sideways, and the filters work", async ({ page }) => {
    const word = tag();
    const job = await insertRequisition({ ...live, title: `Mobile Developer ${word}`, locationCode: "KRAKOW" });
    await page.goto("/jobs");
    await expectNoHorizontalScroll(page);
    await page.getByRole("searchbox", { name: "Keywords" }).fill(word);
    await page.getByLabel("Location").selectOption({ label: "Kraków, Poland" });
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByTestId("job-listing")).toHaveCount(1);
    await expectNoHorizontalScroll(page);

    await page.goto(`/jobs/${job.id}`);
    await expectNoHorizontalScroll(page);
    const closed = await insertRequisition({ ...live, isPublished: false, state: "CLOSED" });
    await page.goto(`/jobs/${closed.id}`);
    await expectNoHorizontalScroll(page);
    const privateJob = await insertRequisition({ ...live, postingType: "PRIVATE" });
    await page.goto(`/jobs/p/${privateJob.privateSlug}`);
    await expectNoHorizontalScroll(page);
  });
});

test("the board works with the keyboard: skip link, search field and a job link", async ({ page }) => {
  const word = tag();
  const job = await insertRequisition({ ...live, title: `Keyboard Tester ${word}` });
  await page.goto(`/jobs?q=${word}`);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  const link = page.getByRole("link", { name: job.title });
  for (let i = 0; i < 15 && !(await link.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: job.title })).toBeVisible();
});
