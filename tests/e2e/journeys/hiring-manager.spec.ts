// The Hiring Manager's journey (tech-stack.md §11, T5, task 46): drafts and
// submits a requisition, decides approvals, approves a re-approval (L2), and
// reads applications without being able to change them (V4, V9).
import { insertApplication } from "../support/applications";
import { query } from "../support/db";
import { expect, test } from "../support/fixtures";
import { approveRequisition, createOffer, createRequisition, live, submitOffer, submitRequisition, uniqueWord, userId } from "../support/journeys";
import { insertRequisition } from "../support/requisitions";
import { ROLES } from "../support/users";

const HM = ROLES["hiring-manager"].name;

test("Hiring Manager journey: creates a draft and submits it to an Admin, who approves it", async ({ asRole }) => {
  const hm = await asRole("hiring-manager");
  const created = await createRequisition(hm, `Team Lead ${uniqueWord("Journey")}`);
  await submitRequisition(hm, created.id, ROLES.admin.name);
  await approveRequisition(await asRole("admin"), created.id);
  const [row] = await query<{ state: string }>("SELECT state FROM requisitions WHERE id = $1", [created.id]);
  expect(row.state).toBe("APPROVED");
});

test("Hiring Manager journey: approves a requisition and an offer, and rejects another offer with a comment", async ({ asRole }) => {
  const hm = await asRole("hiring-manager");
  const recruiter = await asRole("recruiter");

  const draft = await insertRequisition();
  await submitRequisition(recruiter, draft.id, HM);
  await hm.goto("/approvals");
  await expect(hm.getByTestId(`approval-${draft.reqNumber}`)).toBeVisible();
  await approveRequisition(hm, draft.id);

  const job = await insertRequisition(live);
  const approved = await insertApplication(job.id, { status: "OFFER", withCv: false });
  const rejected = await insertApplication(job.id, { status: "OFFER", withCv: false });
  await recruiter.goto(`/applications/${approved.id}`);
  const approvedOffer = await createOffer(recruiter, approved.id);
  await submitOffer(recruiter, approvedOffer, HM);
  await recruiter.goto(`/applications/${rejected.id}`);
  const rejectedOffer = await createOffer(recruiter, rejected.id);
  await submitOffer(recruiter, rejectedOffer, HM);

  await hm.goto("/approvals");
  await hm.getByTestId(`offer-approval-${approvedOffer}`).getByRole("link").click();
  await hm.getByTestId(`offer-${approvedOffer}`).getByRole("button", { name: "Approve" }).click();
  await hm.getByRole("form", { name: "Approve" }).getByRole("button", { name: "Approve" }).click();
  await expect(hm.getByTestId(`offer-${approvedOffer}`)).toContainText("Approval: Approved");

  await hm.goto("/approvals");
  await hm.getByTestId(`offer-approval-${rejectedOffer}`).getByRole("link").click();
  await hm.getByTestId(`offer-${rejectedOffer}`).getByRole("button", { name: "Reject" }).click();
  const form = hm.getByRole("form", { name: "Reject" });
  await form.getByLabel("Comment", { exact: true }).fill("The salary is above the band.");
  await form.getByRole("button", { name: "Reject" }).click();
  await expect(hm.getByTestId(`offer-latest-${rejectedOffer}`)).toContainText("The salary is above the band.");

  const rows = await query<{ id: string; approval_status: string }>("SELECT id, approval_status FROM offers WHERE id = ANY($1)", [[approvedOffer, rejectedOffer]]);
  expect(rows.find((row) => row.id === approvedOffer)?.approval_status).toBe("APPROVED");
  expect(rows.find((row) => row.id === rejectedOffer)?.approval_status).toBe("REJECTED");
});

test("Hiring Manager journey: approves a re-approval after an openings increase (L2)", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const recruiter = await asRole("recruiter");
  await recruiter.goto(`/requisitions/${job.id}/edit`);
  const form = recruiter.getByRole("form", { name: "Save requisition" });
  await form.getByLabel("Openings").fill("3");
  await form.getByTestId("reapproval-picker").getByLabel("Approver for the re-approval").selectOption({ label: HM });
  await form.getByRole("button", { name: "Save requisition" }).click();
  await expect(recruiter.getByTestId("reapproval-changes")).toContainText("Openings: 1 → 3");

  const hm = await asRole("hiring-manager");
  await hm.goto("/approvals");
  const row = hm.getByTestId(`approval-${job.reqNumber}`);
  await expect(row).toContainText("Re-approval");
  await row.getByRole("link", { name: job.reqNumber }).click();
  await hm.getByRole("button", { name: "Approve" }).click();
  await hm.getByRole("form", { name: "Approve" }).getByRole("button", { name: "Approve" }).click();
  await expect(hm.getByTestId("reapproval-changes")).toHaveCount(0);

  const [stored] = await query<{ state: string; openings_count: number; is_published: boolean }>(
    "SELECT state, openings_count, is_published FROM requisitions WHERE id = $1",
    [job.id],
  );
  expect(stored).toEqual({ state: "APPROVED", openings_count: 3, is_published: true });
});

test("Hiring Manager journey: reads an application without a status control (403 on the API) and gets 404 outside their scope", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id, { status: "SCREENING", withCv: false });
  const hm = await asRole("hiring-manager");
  await hm.goto(`/applications/${application.id}`);
  await expect(hm.getByRole("heading", { level: 1, name: `${application.firstName} ${application.lastName}` })).toBeVisible();
  await expect(hm.getByRole("form", { name: "Change status" })).toHaveCount(0);
  const change = await hm.request.post(`/api/applications/${application.id}/status`, { data: { toStatus: "INTERVIEW", version: 1 } });
  expect(change.status()).toBe(403);
  const [row] = await query<{ status: string }>("SELECT status FROM applications WHERE id = $1", [application.id]);
  expect(row.status).toBe("SCREENING");

  const elsewhere = await insertRequisition(live);
  const outside = await insertApplication(elsewhere.id, { withCv: false });
  const admin = await userId(ROLES.admin.email);
  await query("UPDATE requisitions SET hiring_manager_id = $1, created_by_user_id = $1 WHERE id = $2", [admin, elsewhere.id]);
  expect((await hm.goto(`/requisitions/${elsewhere.id}`))?.status()).toBe(404);
  expect((await hm.goto(`/applications/${outside.id}`))?.status()).toBe(404);
});
