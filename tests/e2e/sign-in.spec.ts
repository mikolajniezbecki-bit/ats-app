// Dev sign-in, sessions and the proxy against the running app (AU5, AU6, AU7,
// §3 rule 6). Specs that change a user use their own throwaway user.
import { expect, test } from "./support/fixtures";
import { query } from "./support/db";
import { signInThroughForm } from "./support/sign-in";
import { createThrowawayUser } from "./support/users";

const sessionCount = async (userId: string) =>
  Number((await query<{ count: string }>("SELECT count(*) FROM session WHERE user_id = $1", [userId]))[0].count);

test("AU7: a dev user signs in, one session row is created and later pages are authenticated", async ({ page, context }) => {
  const user = createThrowawayUser();

  await signInThroughForm(page, user.email, user.password);

  await expect(page).toHaveURL(/\/dashboard$/);
  expect(await sessionCount(user.id)).toBe(1);
  const second = await context.newPage();
  await second.goto("/dashboard");
  await expect(second.getByTestId("user-name")).toHaveText(`Signed in as ${user.name}`);
});

test("AU5: a role changed in the database shows after a reload, without signing in again", async ({ page }) => {
  const user = createThrowawayUser("RECRUITER");
  await signInThroughForm(page, user.email, user.password);
  await expect(page.getByTestId("user-role")).toHaveText("Role: RECRUITER");

  await query("UPDATE users SET role = 'HIRING_MANAGER' WHERE id = $1", [user.id]);
  await page.reload();

  await expect(page.getByTestId("user-role")).toHaveText("Role: HIRING_MANAGER");
});

test("AU5: an inactive user sees the AU2 message and gets no session", async ({ page }) => {
  const user = createThrowawayUser();
  await query("UPDATE users SET is_active = false WHERE id = $1", [user.id]);

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.locator("form").getByRole("alert")).toHaveText("Access not granted, contact your ATS admin.");
  expect(await sessionCount(user.id)).toBe(0);
});

test("a wrong password and an unknown email show the same message", async ({ page }) => {
  const user = createThrowawayUser();
  for (const [email, password] of [
    [user.email, "not-the-password"],
    [`nobody-${user.id}@example.com`, user.password],
  ]) {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText("Invalid email or password.");
  }
});

test("the sign-in form works with the keyboard alone", async ({ page }) => {
  const user = createThrowawayUser();
  await page.goto("/sign-in");
  await page.getByLabel("Email").focus();
  await page.keyboard.type(user.email);
  await page.keyboard.press("Tab");
  await page.keyboard.type(user.password);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("next accepts relative paths only", async ({ page }) => {
  const user = createThrowawayUser();
  for (const next of ["https://evil.example", "//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/.//evil.example", "/..//evil.example", "/%2e//evil.example"]) {
    await page.context().clearCookies();
    await signInThroughForm(page, user.email, user.password, `/sign-in?next=${encodeURIComponent(next)}`);
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/dashboard$/);
  }
  await page.context().clearCookies();
  await signInThroughForm(page, user.email, user.password, `/sign-in?next=${encodeURIComponent("/dashboard?x=1")}`);
  await expect(page).toHaveURL(/\/dashboard\?x=1$/);
});

test("a signed-in user opening /sign-in goes to /dashboard", async ({ asRole }) => {
  const page = await asRole("recruiter");
  await page.goto("/sign-in");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("user-role")).toHaveText("Role: RECRUITER");
});

test("sign-out deletes the session row and clears the cookie", async ({ page }) => {
  const user = createThrowawayUser();
  await signInThroughForm(page, user.email, user.password);

  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page).toHaveURL(/\/sign-in/);
  expect(await sessionCount(user.id)).toBe(0);
  expect((await page.context().cookies()).some((c) => c.name.includes("session_token"))).toBe(false);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fdashboard$/);
});

test("AU6: an expired session redirects to sign-in, without a loop, and signing in works from there", async ({ page }) => {
  const user = createThrowawayUser();
  await signInThroughForm(page, user.email, user.password);
  await query("UPDATE session SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [user.id]);

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fdashboard$/);

  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("a stale or invalid session cookie ends on /sign-in", async ({ page, baseURL }) => {
  await page.context().addCookies([
    {
      name: "__Secure-better-auth.session_token",
      value: "not-a-real-token",
      domain: new URL(baseURL!).hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fdashboard$/);
  await expect(page.getByLabel("Email")).toBeVisible();
});

test.describe("proxy without a cookie", () => {
  test("the tick gets its own 401, never a sign-in redirect", async ({ request }) => {
    const response = await request.post("/api/internal/tick", { maxRedirects: 0 });
    expect(response.status()).toBe(401);
    expect(response.headers().location).toBeUndefined();
  });

  for (const path of ["/", "/sign-in", "/jobs", "/jobs/p/abc", "/api/health", "/api/auth/get-session"]) {
    test(`${path} is not redirected to sign-in`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.headers().location ?? "").not.toContain("/sign-in");
      expect(response.status()).not.toBe(401);
    });
  }

  test("/dashboard redirects to sign-in with next", async ({ request }) => {
    const response = await request.get("/dashboard", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers().location).toMatch(/\/sign-in\?next=%2Fdashboard$/);
    expect(response.headers()["x-request-id"]).toBeTruthy();
  });

  test("a protected API route returns 401 JSON", async ({ request }) => {
    const response = await request.get("/api/admin/anything", { maxRedirects: 0 });
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});

test("each shared role signs in from its saved state", async ({ asRole }) => {
  for (const [role, label] of [
    ["admin", "ADMIN"],
    ["recruiter", "RECRUITER"],
    ["hiring-manager", "HIRING_MANAGER"],
    ["interviewer", "INTERVIEWER"],
  ] as const) {
    const page = await asRole(role);
    await page.goto("/dashboard");
    await expect(page.getByTestId("user-role")).toHaveText(`Role: ${label}`);
  }
});
