// Fills in the Quick Apply form for specs (ats-project-scope.md §5.3).
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

export const VALID_PDF = "tests/fixtures/pdf/valid.pdf";

export type Candidate = { firstName: string; lastName: string; email: string; phone: string };

export function newCandidate(): Candidate {
  return { firstName: "Łucja", lastName: "Testowa", email: `e2e-${randomUUID()}@example.com`, phone: "+00 600 100 200" };
}

/** Fills the contact fields, attaches the CV and accepts the privacy statement; answers are up to the spec. */
export async function fillApplication(page: Page, candidate: Candidate, options: { cv?: string; consent?: boolean } = {}) {
  const form = page.getByRole("form", { name: "Application form" });
  await form.getByLabel("First name").fill(candidate.firstName);
  await form.getByLabel("Last name").fill(candidate.lastName);
  await form.getByLabel("Email").fill(candidate.email);
  await form.getByLabel("Phone").fill(candidate.phone);
  await form.getByLabel("CV (PDF)").setInputFiles(options.cv ?? VALID_PDF);
  if (options.consent ?? true) await form.getByRole("checkbox", { name: /I have read the privacy statement/ }).check();
  return form;
}
