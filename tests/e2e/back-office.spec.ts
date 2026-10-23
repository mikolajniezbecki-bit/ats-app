// Back-office shell and the /admin guard (V1, V9, T5): navigation follows the
// role, and a direct request to an Admin page gets a real HTTP 403.
import { expect, test } from "./support/fixtures";
import { ROLES } from "./support/users";

test("V1: Admin sees Administration and opens /admin", async ({ asRole }) => {
  const page = await asRole("admin");
  await page.goto("/dashboard");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("header-user-name")).toHaveText(ROLES.admin.name);
  await expect(page.getByTestId("header-user-role")).toHaveText("Admin");

  await nav.getByRole("link", { name: "Administration" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Administration" })).toHaveAttribute("aria-current", "page");

  const response = await page.goto("/admin");
  expect(response?.status()).toBe(200);
});

for (const role of ["recruiter", "hiring-manager", "interviewer"] as const) {
  test(`AU9: ${role} has no Administration link and gets HTTP 403 on /admin`, async ({ asRole }) => {
    const page = await asRole(role);
    await page.goto("/dashboard");
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);

    const response = await page.goto("/admin");
    expect(response?.status()).toBe(403);
    await expect(page.getByRole("heading", { name: "You don't have access to this page." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Administration" })).toHaveCount(0);
    await page.getByRole("link", { name: "Go to the dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });
}

test("the navigation is keyboard-reachable", async ({ asRole }) => {
  const page = await asRole("admin");
  await page.goto("/dashboard");
  const home = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" });
  for (let i = 0; i < 10 && !(await home.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(home).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Administration" })).toBeFocused();
});
