// The approval request (ats-project-scope.md E7, §5.1 System emails): a fixed
// text from messages/en.json, built in code and queued to the approver on
// every submission. It is a STAFF email linked to the requisition, so it
// gets the E2 Reply-To but no candidate footer, and it never appears in bulk
// email. The link is a plain-text URL, because P3 markup has no links.
import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getConfig } from "../config";
import type { Tx } from "../db";
import { requisitions, users } from "../db/schema";
import { message } from "../messages";
import { queueEmail } from "./index";

/** Values inserted into the text before tokens are resolved can't open a token. */
const plain = (value: string) => value.replaceAll("[[", "[ [");

export async function queueRequisitionApprovalRequest(tx: Tx, requisitionId: string): Promise<string> {
  const approver = alias(users, "approver");
  const submitter = alias(users, "submitter");
  const hiringManager = alias(users, "hiring_manager");
  const [row] = await tx
    .select({
      reqNumber: requisitions.reqNumber,
      title: requisitions.title,
      approverEmail: approver.email,
      submitterName: submitter.name,
      hiringManagerName: hiringManager.name,
    })
    .from(requisitions)
    .innerJoin(approver, eq(approver.id, requisitions.approverId))
    .innerJoin(submitter, eq(submitter.id, requisitions.submittedByUserId))
    .innerJoin(hiringManager, eq(hiringManager.id, requisitions.hiringManagerId))
    .where(eq(requisitions.id, requisitionId));
  if (!row) throw new Error("Requisition has no pending submission");
  const link = `${getConfig().auth.url.replace(/\/$/, "")}/requisitions/${requisitionId}`;
  return queueEmail(tx, {
    to: row.approverEmail,
    audience: "STAFF",
    requisitionId,
    subject: message("Email.approvalRequest.subject"),
    body: message("Email.approvalRequest.body", { submitter: plain(row.submitterName), link }),
    values: { REQ_NUMBER: row.reqNumber, JOB_TITLE: row.title, HIRING_MGR_FULL_NAME: row.hiringManagerName },
  });
}
