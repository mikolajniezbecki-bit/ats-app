// The Recruiter's journey from a new requisition to the hire export
// (tech-stack.md §11, task 46): the Hiring Manager approves through
// `asRole`, a candidate applies on the public form, and emails are read from
// Mailpit.
import { readFile } from "node:fs/promises";
import { waitForMessage } from "../../support/mailpit";
import { fillApplication, newCandidate } from "../support/apply";
import { query } from "../support/db";
import { expect, test } from "../support/fixtures";
import { approveRequisition, changeStatus, createOffer, createRequisition, submitOffer, submitRequisition, uniqueWord } from "../support/journeys";
import { ROLES } from "../support/users";

const YEAR = new Date().getUTCFullYear() + 1;

test("Recruiter journey: requisition, approval, application, interview, offer, hire and export", async ({ asRole, page: visitor }) => {
  test.setTimeout(180_000);
  const word = uniqueWord("Journey");
  const title = `Site Engineer ${word}`;
  const candidate = { ...newCandidate(), lastName: word };
  const candidateName = `${candidate.firstName} ${candidate.lastName}`;
  const recruiter = await asRole("recruiter");
  const hm = await asRole("hiring-manager");

  const job = await test.step("creates a requisition with a pre-screening question and submits it", async () => {
    const created = await createRequisition(recruiter, title);
    const section = recruiter.getByRole("region", { name: "Pre-screening questions" });
    await section.getByRole("button", { name: "Add question" }).click();
    const form = section.getByRole("form", { name: "New question" });
    await form.getByLabel("Question", { exact: true }).fill("Do you have a work permit?");
    await form.getByLabel("Type").selectOption("YES_NO");
    await form.getByLabel("Weight (0–100)").fill("10");
    await form.getByLabel("Scoring answer").selectOption("YES");
    await form.getByRole("button", { name: "Save question" }).click();
    await expect(section.getByTestId("prescreen-question")).toHaveCount(1);
    await submitRequisition(recruiter, created.id, ROLES["hiring-manager"].name);
    return created;
  });

  await test.step("after the approval the job is on /jobs", async () => {
    await visitor.goto(`/jobs?q=${word}`);
    await expect(visitor.getByRole("link", { name: title })).toHaveCount(0);
    await approveRequisition(hm, job.id);
    await visitor.goto(`/jobs?q=${word}`);
    await expect(visitor.getByRole("link", { name: title })).toBeVisible();
  });

  const applicationId = await test.step("a candidate applies and gets the acknowledgement email", async () => {
    await visitor.getByRole("link", { name: title }).click();
    await visitor.getByRole("link", { name: "Apply now" }).click();
    const form = await fillApplication(visitor, candidate);
    await form.getByRole("group", { name: "Do you have a work permit?" }).getByLabel("Yes").check();
    await form.getByRole("button", { name: "Submit application" }).click();
    await expect(visitor.getByRole("heading", { name: "Thank you" })).toBeVisible();
    const acknowledgement = await waitForMessage({ to: candidate.email, subjectIncludes: title, timeoutMs: 30_000 });
    expect(acknowledgement.subject).toContain(title);
    const [row] = await query<{ id: string; status: string }>("SELECT id, status FROM applications WHERE email = $1", [candidate.email]);
    expect(row.status).toBe("APPLIED");
    return row.id;
  });

  await test.step("moves the application to Screening and schedules an interview; the invite has an .ics", async () => {
    await recruiter.goto(`/requisitions/${job.id}/applications`);
    await recruiter.getByTestId(`application-row-${applicationId}`).getByRole("link", { name: "Open" }).click();
    await changeStatus(recruiter, "Screening");
    await recruiter.getByRole("button", { name: "Schedule interview" }).click();
    const form = recruiter.getByRole("form", { name: "Schedule interview" });
    await form.getByLabel("Date and start time").fill(`${YEAR}-02-10T10:00`);
    await form.getByLabel("Time zone").selectOption("Europe/Warsaw");
    await form.getByLabel("Duration (minutes)").fill("45");
    await form.getByLabel("Location or meeting link").fill("https://meet.example.com/journey");
    await form.getByLabel(ROLES.interviewer.name).check();
    await form.getByRole("button", { name: "Schedule" }).click();
    await expect(recruiter.getByRole("region", { name: "Interviews" }).getByText("https://meet.example.com/journey")).toBeVisible();
    const invite = await waitForMessage({ to: ROLES.interviewer.email, subjectIncludes: candidateName, timeoutMs: 30_000 });
    const ics = invite.attachments.find((file) => file.name === "invite.ics");
    expect(ics?.bytes.toString("utf8")).toContain("BEGIN:VEVENT");
  });

  const offerId = await test.step("moves to Offer, creates and submits an offer, and previews the PDF", async () => {
    await changeStatus(recruiter, "Offer");
    const id = await createOffer(recruiter, applicationId);
    const preview = await recruiter.request.get((await recruiter.getByTestId(`offer-${id}`).getByRole("link", { name: "Preview PDF" }).getAttribute("href"))!);
    expect(preview.status()).toBe(200);
    expect(preview.headers()["content-type"]).toBe("application/pdf");
    await submitOffer(recruiter, id, ROLES["hiring-manager"].name);
    return id;
  });

  await test.step("after the offer approval the candidate's email has the letter attached", async () => {
    await hm.goto("/approvals");
    await hm.getByTestId(`offer-approval-${offerId}`).getByRole("link").click();
    await hm.getByTestId(`offer-${offerId}`).getByRole("button", { name: "Approve" }).click();
    await hm.getByRole("form", { name: "Approve" }).getByRole("button", { name: "Approve" }).click();
    await expect(hm.getByTestId(`offer-${offerId}`)).toContainText("Approval: Approved");
    const letter = await waitForMessage({ to: candidate.email, subjectIncludes: "Your offer for", timeoutMs: 30_000 });
    const pdf = letter.attachments.find((file) => file.contentType === "application/pdf");
    expect(pdf?.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  await test.step("records Accepted and hires; the requisition is Closed (Filled) and leaves /jobs", async () => {
    await recruiter.reload();
    const card = recruiter.getByTestId(`offer-${offerId}`);
    await card.getByRole("button", { name: "Record response" }).click();
    const form = recruiter.getByRole("form", { name: "Record response" });
    await form.getByLabel("Accepted").check();
    await form.getByRole("button", { name: "Save response" }).click();
    await expect(card).toContainText("Candidate response: Accepted");
    const status = recruiter.getByRole("form", { name: "Change status" });
    await status.getByLabel("New status").selectOption({ label: "Hired" });
    await status.getByRole("button", { name: "Change status" }).click();
    await expect(recruiter.getByText("No status change is possible now.")).toBeVisible();
    await recruiter.goto(`/requisitions/${job.id}`);
    const facts = recruiter.getByTestId("lifecycle-facts");
    await expect(facts).toContainText("Closed");
    await expect(facts).toContainText("Filled");
    await visitor.goto(`/jobs?q=${word}`);
    await expect(visitor.getByRole("link", { name: title })).toHaveCount(0);
  });

  await test.step("downloads the hire CSV containing the candidate", async () => {
    await recruiter.goto("/exports");
    const form = recruiter.getByRole("form", { name: "Hire export" });
    // Include already exported: a parallel spec's default export may have taken this hire first.
    await form.getByLabel("Include already exported").check();
    const [download] = await Promise.all([recruiter.waitForEvent("download"), form.getByRole("button", { name: "Export hires" }).click()]);
    const csv = (await readFile((await download.path())!)).toString("utf8");
    const line = csv.split("\r\n").find((row) => row.startsWith(applicationId));
    expect(line).toContain(job.reqNumber);
    expect(line).toContain(candidate.email);
  });
});
