// Pre-screening question editor on the Compose stack (ats-project-scope.md
// §5.3, S1).
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";

test("S1: a Recruiter adds a YES_NO and a TEXT question; the TEXT one has no weight or answers, and both stay in order", async ({ asRole }) => {
  const requisition = await insertRequisition();
  const page = await asRole("recruiter");
  await page.goto(`/requisitions/${requisition.id}`);
  const section = page.getByRole("region", { name: "Pre-screening questions" });

  await section.getByRole("button", { name: "Add question" }).click();
  let form = section.getByRole("form", { name: "New question" });
  await form.getByLabel("Question", { exact: true }).fill("Do you have a work permit for Poland?");
  await form.getByLabel("Type").selectOption("YES_NO");
  await form.getByLabel("Weight (0–100)").fill("10");
  await form.getByLabel("Scoring answer").selectOption("YES");
  await form.getByLabel("Disqualifying answer").selectOption("NO");
  await form.getByRole("button", { name: "Save question" }).click();
  await expect(section.getByTestId("prescreen-question")).toHaveCount(1);

  await section.getByRole("button", { name: "Add question" }).click();
  form = section.getByRole("form", { name: "New question" });
  await form.getByLabel("Question", { exact: true }).fill("Anything else we should know?");
  await form.getByLabel("Type").selectOption("TEXT");
  await expect(form.getByLabel("Weight (0–100)")).toHaveCount(0);
  await expect(form.getByLabel("Scoring answer")).toHaveCount(0);
  await expect(form.getByLabel("Disqualifying answer")).toHaveCount(0);
  await form.getByRole("button", { name: "Save question" }).click();
  await expect(section.getByTestId("prescreen-question")).toHaveCount(2);

  await page.reload();
  const items = page.getByRole("region", { name: "Pre-screening questions" }).getByTestId("prescreen-question");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("1. Do you have a work permit for Poland?");
  await expect(items.nth(0)).toContainText("Yes / No · weight 10");
  await expect(items.nth(0)).toContainText("Disqualifies on: No");
  await expect(items.nth(1)).toContainText("2. Anything else we should know?");
  await expect(items.nth(1)).toContainText("Text · weight 0");

  // Keyboard reorder: move the second question up.
  await items.nth(1).getByRole("button", { name: "Move question 2 up" }).click();
  await expect(items.nth(0)).toContainText("Anything else we should know?");
});
