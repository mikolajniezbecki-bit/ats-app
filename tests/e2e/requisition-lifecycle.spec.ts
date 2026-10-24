// Requisition lifecycle on the Compose stack (ats-project-scope.md §5.2 L4–L7):
// a Recruiter holds, resumes and closes a requisition; an Admin reopens it.
// The job board and the job page follow each step.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";

async function act(page: Page, action: string, comment?: string) {
  await page.getByRole("button", { name: action, exact: true }).click();
  const form = page.getByRole("form", { name: action });
  if (comment !== undefined) await form.getByLabel(/^Comment/).fill(comment);
  await form.getByRole("button", { name: action }).click();
  await expect(form).toBeHidden();
}

async function expectOnBoard(page: Page, word: string, listed: boolean) {
  await page.goto(`/jobs?q=${word}`);
  const link = page.getByRole("link", { name: new RegExp(word) });
  if (listed) await expect(link).toBeVisible();
  else await expect(link).toHaveCount(0);
}

test("a Recruiter holds, resumes and closes a requisition; an Admin reopens it; the job board follows", async ({ asRole }) => {
  const word = `Lifecycle${randomUUID().slice(0, 8)}`;
  const job = await insertRequisition({ title: `Line Operator ${word}`, state: "APPROVED", approved: true, isPublished: true });
  const recruiter = await asRole("recruiter");
  const board = await asRole("recruiter");
  const facts = recruiter.getByTestId("lifecycle-facts");

  await expectOnBoard(board, word, true);
  await recruiter.goto(`/requisitions/${job.id}`);
  await act(recruiter, "Put on hold", "Budget review");
  await expect(facts).toContainText("On hold");
  await expect(facts).toContainText("Not published");
  await expectOnBoard(board, word, false);
  await board.goto(`/jobs/${job.id}`);
  await expect(board.getByText("This position is no longer accepting applications.")).toBeVisible();

  await act(recruiter, "Resume");
  await expect(facts).toContainText("Approved");
  await expect(facts).toContainText("Published");
  await expectOnBoard(board, word, true);

  await recruiter.getByRole("button", { name: "Close", exact: true }).click();
  await expect(recruiter.getByRole("form", { name: "Close" })).toContainText("0 open applications will be rejected and 0 offers withdrawn.");
  await recruiter.getByRole("form", { name: "Close" }).getByRole("button", { name: "Close" }).click();
  await expect(recruiter.getByRole("form", { name: "Close" }).getByRole("alert")).toHaveText("Add a comment to close.");
  await recruiter.getByRole("form", { name: "Close" }).getByLabel(/^Comment/).fill("Position cancelled");
  await recruiter.getByRole("form", { name: "Close" }).getByRole("button", { name: "Close" }).click();
  await expect(facts).toContainText("Closed");
  await expect(facts).toContainText("Cancelled");
  await expect(recruiter.getByRole("button", { name: "Reopen" })).toHaveCount(0);
  await expectOnBoard(board, word, false);

  const admin = await asRole("admin");
  await admin.goto(`/requisitions/${job.id}`);
  await act(admin, "Reopen", "Budget restored");
  await expect(admin.getByTestId("lifecycle-facts")).toContainText("Approved");
  await expectOnBoard(board, word, true);

  const [row] = await query<{ state: string; is_published: boolean; close_reason: string | null }>(
    "SELECT state, is_published, close_reason FROM requisitions WHERE id = $1",
    [job.id],
  );
  expect(row).toEqual({ state: "APPROVED", is_published: true, close_reason: null });
});
