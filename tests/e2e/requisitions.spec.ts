// Requisition drafting on the Compose stack (ats-project-scope.md §5.2, L9,
// V2, V3a, T5).
import { randomUUID } from "node:crypto";
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";

test("V2: a Recruiter creates a requisition from the Standard requisition template, sees it in DRAFT and edits the title", async ({ asRole }) => {
  const title = `E2E Backend Engineer ${randomUUID().slice(0, 8)}`;
  const page = await asRole("recruiter");
  await page.goto("/requisitions");
  await page.getByRole("link", { name: "New requisition" }).click();

  const form = page.getByRole("form", { name: "New requisition" });
  await form.getByLabel("Template").selectOption({ label: "Standard requisition" });
  await form.getByLabel("Job title").fill(title);
  await form.getByLabel("Department").selectOption({ label: "Engineering" });
  await form.getByLabel("Location").selectOption({ label: "Warsaw, Poland" });
  await form.getByLabel("Legal entity").selectOption({ label: "ATS Demo Polska Sp. z o.o." });
  await form.getByLabel("Hiring manager").selectOption({ label: "E2E Hiring Manager" });
  await form.getByLabel("Recruiter").selectOption({ label: "E2E Recruiter" });
  await form.getByLabel("Openings").fill("2");
  await form.getByRole("textbox", { name: "Description" }).fill("We build an applicant tracking system.");

  // The required picklist value is checked by the server and shown next to its field.
  await form.getByRole("button", { name: "Save requisition" }).click();
  await expect(form.getByText("This field is required.")).toBeVisible();
  await form.getByLabel("Employment type").selectOption({ label: "Full-time" });
  await form.getByRole("button", { name: "Save requisition" }).click();

  await expect(page.getByRole("heading", { name: new RegExp(`^REQ-\\d{5} · ${title}$`) })).toBeVisible();
  const [row] = await query<{ id: string; req_number: string; state: string; custom_fields_json: Record<string, unknown>; description_html: string }>(
    "SELECT id, req_number, state, custom_fields_json, description_html FROM requisitions WHERE title = $1",
    [title],
  );
  expect(row).toMatchObject({ state: "DRAFT", custom_fields_json: { employment_type: "FULL_TIME" } });
  expect(row.description_html).toBe("<p>We build an applicant tracking system.</p>");

  await page.goto("/requisitions?state=DRAFT");
  const listed = page.getByTestId(`requisition-${row.req_number}`);
  await expect(listed).toContainText(title);
  await expect(listed).toContainText("Draft");

  await listed.getByRole("link", { name: row.req_number }).click();
  await page.getByRole("link", { name: "Edit" }).click();
  const edit = page.getByRole("form", { name: "Save requisition" });
  await edit.getByLabel("Job title").fill(`${title} (edited)`);
  await edit.getByRole("button", { name: "Save requisition" }).click();
  await expect(page.getByRole("heading", { name: `${row.req_number} · ${title} (edited)` })).toBeVisible();
});

test("V3: an Interviewer has no Requisitions navigation and gets 403 from the list page and API", async ({ asRole }) => {
  const page = await asRole("interviewer");
  await page.goto("/dashboard");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Requisitions" })).toHaveCount(0);
  expect((await page.goto("/requisitions"))?.status()).toBe(403);
  expect((await page.request.get("/api/requisitions")).status()).toBe(403);
});
