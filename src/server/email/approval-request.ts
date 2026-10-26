// The approval request (ats-project-scope.md E7, §5.1 System emails) and the
// A6 reminder: fixed texts from messages/en.json, built in code and queued to
// the approver. Both are STAFF emails linked to the requisition, so they
// get the E2 Reply-To but no candidate footer, and neither appears in bulk
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

type PendingRequisition = {
  reqNumber: string;
  title: string;
  approverEmail: string;
  submitterName: string;
  submitterEmail: string;
  submitterActive: boolean;
  hiringManagerName: string;
};

/** The pending submission's texts and addresses; throws when there is none. */
async function pendingRequisition(tx: Tx, requisitionId: string): Promise<PendingRequisition> {
  const approver = alias(users, "approver");
  const submitter = alias(users, "submitter");
  const hiringManager = alias(users, "hiring_manager");
  const [row] = await tx
    .select({
      reqNumber: requisitions.reqNumber,
      title: requisitions.title,
      approverEmail: approver.email,
      submitterName: submitter.name,
      submitterEmail: submitter.email,
      submitterActive: submitter.isActive,
      hiringManagerName: hiringManager.name,
    })
    .from(requisitions)
    .innerJoin(approver, eq(approver.id, requisitions.approverId))
    .innerJoin(submitter, eq(submitter.id, requisitions.submittedByUserId))
    .innerJoin(hiringManager, eq(hiringManager.id, requisitions.hiringManagerId))
    .where(eq(requisitions.id, requisitionId));
  if (!row) throw new Error("Requisition has no pending submission");
  return row;
}

const requisitionLink = (requisitionId: string) => `${getConfig().auth.url.replace(/\/$/, "")}/requisitions/${requisitionId}`;

/** E7: on submission, re-approval and reassignment (A4), to the current approver. */
export async function queueRequisitionApprovalRequest(tx: Tx, requisitionId: string): Promise<string> {
  const row = await pendingRequisition(tx, requisitionId);
  return queueEmail(tx, {
    to: row.approverEmail,
    audience: "STAFF",
    requisitionId,
    subject: message("Email.approvalRequest.subject"),
    body: message("Email.approvalRequest.body", { submitter: plain(row.submitterName), link: requisitionLink(requisitionId) }),
    values: { REQ_NUMBER: row.reqNumber, JOB_TITLE: row.title, HIRING_MGR_FULL_NAME: row.hiringManagerName },
  });
}

/**
 * A6: the daily reminder to the current approver, Cc the submitter unless
 * they are inactive (then no Cc). `daysWaiting` counts calendar days since
 * the submission.
 */
export async function queueRequisitionApprovalReminder(tx: Tx, requisitionId: string, daysWaiting: number): Promise<string> {
  const row = await pendingRequisition(tx, requisitionId);
  return queueEmail(tx, {
    to: row.approverEmail,
    cc: row.submitterActive ? [row.submitterEmail] : [],
    audience: "STAFF",
    requisitionId,
    subject: message("Email.approvalReminder.subject"),
    body: message("Email.approvalReminder.body", {
      submitter: plain(row.submitterName),
      days: String(daysWaiting),
      link: requisitionLink(requisitionId),
    }),
    values: { REQ_NUMBER: row.reqNumber, JOB_TITLE: row.title, HIRING_MGR_FULL_NAME: row.hiringManagerName },
  });
}
