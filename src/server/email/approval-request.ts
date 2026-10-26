// The approval request (ats-project-scope.md E7, §5.1 System emails) and the
// A6 reminder, for requisitions and offers: fixed texts from
// messages/en.json, built in code and queued to the approver. They are STAFF
// emails linked to the requisition, so they get the E2 Reply-To but no
// candidate footer, and none appears in bulk email. Offer emails name the
// candidate and carry no salary, and are linked to the application so the
// purge clears them (RT4, task 36 Q6). Links are plain-text URLs, because P3
// markup has no links.
import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getConfig } from "../config";
import type { Tx } from "../db";
import { applications, offers, requisitions, users } from "../db/schema";
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

type PendingOffer = {
  applicationId: string;
  requisitionId: string;
  reqNumber: string;
  jobTitle: string;
  candidate: string;
  approverEmail: string;
  submitterName: string;
  submitterEmail: string;
  submitterActive: boolean;
};

async function pendingOffer(tx: Tx, offerId: string): Promise<PendingOffer> {
  const approver = alias(users, "approver");
  const submitter = alias(users, "submitter");
  const [row] = await tx
    .select({
      applicationId: offers.applicationId,
      requisitionId: requisitions.id,
      reqNumber: requisitions.reqNumber,
      jobTitle: offers.jobTitle,
      firstName: applications.firstName,
      lastName: applications.lastName,
      approverEmail: approver.email,
      submitterName: submitter.name,
      submitterEmail: submitter.email,
      submitterActive: submitter.isActive,
    })
    .from(offers)
    .innerJoin(applications, eq(applications.id, offers.applicationId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(approver, eq(approver.id, offers.approverId))
    .innerJoin(submitter, eq(submitter.id, offers.submittedByUserId))
    .where(eq(offers.id, offerId));
  if (!row) throw new Error("Offer has no pending submission");
  return { ...row, candidate: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() };
}

const applicationLink = (applicationId: string) => `${getConfig().auth.url.replace(/\/$/, "")}/applications/${applicationId}`;

/** E7 (task 36): on submission, re-approval (A8) and reassignment (A4) of an offer, to its current approver. */
export async function queueOfferApprovalRequest(tx: Tx, offerId: string): Promise<string> {
  const row = await pendingOffer(tx, offerId);
  return queueEmail(tx, {
    to: row.approverEmail,
    audience: "STAFF",
    requisitionId: row.requisitionId,
    applicationId: row.applicationId,
    subject: message("Email.offerApprovalRequest.subject"),
    body: message("Email.offerApprovalRequest.body", { submitter: plain(row.submitterName), job: plain(row.jobTitle), link: applicationLink(row.applicationId) }),
    values: { REQ_NUMBER: row.reqNumber, CANDIDATE_FULL_NAME: row.candidate },
  });
}

/** A6 for offers: To the approver, Cc the submitter unless inactive. */
export async function queueOfferApprovalReminder(tx: Tx, offerId: string, daysWaiting: number): Promise<string> {
  const row = await pendingOffer(tx, offerId);
  return queueEmail(tx, {
    to: row.approverEmail,
    cc: row.submitterActive ? [row.submitterEmail] : [],
    audience: "STAFF",
    requisitionId: row.requisitionId,
    applicationId: row.applicationId,
    subject: message("Email.offerApprovalReminder.subject"),
    body: message("Email.offerApprovalReminder.body", {
      submitter: plain(row.submitterName),
      job: plain(row.jobTitle),
      days: String(daysWaiting),
      link: applicationLink(row.applicationId),
    }),
    values: { REQ_NUMBER: row.reqNumber, CANDIDATE_FULL_NAME: row.candidate },
  });
}
