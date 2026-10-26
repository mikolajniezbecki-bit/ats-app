// Offer drafting (ats-project-scope.md §5.6, R10, L6, L8, A8; tech-stack.md
// D3, D7, M2): create, edit and discard, with at most one active offer per
// application. Locks follow the status service's order: the requisition FOR
// SHARE, then the application FOR UPDATE (which also serializes concurrent
// creates, so "latest offer" is well defined), then the offer. The rules are
// the pure checks in domain/offers. Logs carry IDs only, never salaries,
// titles or names.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { applications, approvalEvents, auditLog, offers, requisitions, templates, users } from "../db/schema";
import { warsawRunDate } from "../domain/daily-tasks";
import { jobQueue } from "../adapters/job-queue";
import { approverError, recordApprovalEvent } from "../approvals";
import {
  type CreateRefusal,
  type EditRefusal,
  canDiscard,
  changedTerms,
  createRefusal,
  editRefusal,
  isFrozen,
  isReapprovable,
  offerFieldErrors,
  submitRefusal,
} from "../domain/offers";
import { queueOfferApprovalRequest } from "../email/approval-request";
import { logger } from "../logger";
import { scopeApplicationsFor, scopeOffersFor } from "../policy/filters";
import { type ApprovalResource, type PolicyUser, can } from "../policy/permissions";

export type OfferRow = typeof offers.$inferSelect;
export type OfferError = "invalid" | "notFound" | "stale" | "notDiscardable" | "submitBlocked" | CreateRefusal | EditRefusal;
export type OfferResult = { ok: true; offer: OfferRow } | { ok: false; reason: OfferError; fields?: Record<string, string> };

const salary = z.union([z.string().trim(), z.number().transform(String)]);
const fields = {
  jobTitle: z.string(),
  salary,
  currency: z.string(),
  startDate: z.string(),
  templateId: z.string(),
};
const createSchema = z.object(fields).strict();
// approverId: only for changing an APPROVED offer, which needs re-approval (A8).
const updateSchema = z.object(fields).partial().extend({ version: z.number().int().min(1), approverId: z.string().optional() }).strict();
const versionSchema = z.object({ version: z.number().int().min(1) }).strict();

function zodFields(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") for (const key of issue.keys) result[key] = "invalid";
    else result[String(issue.path[0] ?? "_")] ??= String(issue.path[0] ?? "invalid");
  }
  return result;
}

/** Q5: the field errors by field (codes are the field names), with the active-template check. */
export async function validateOfferFields(
  tx: Tx,
  data: Partial<{ jobTitle: string; salary: string; currency: string; startDate: string; templateId: string }>,
  now: Date,
  storedTemplateId?: string,
): Promise<Record<string, string>> {
  const errors: Record<string, string> = Object.fromEntries(Object.keys(offerFieldErrors(data, warsawRunDate(now))).map((key) => [key, key]));
  // §5.1: a stored template that was deactivated since may stay; a changed one must be active.
  if (data.templateId !== undefined && data.templateId !== storedTemplateId) {
    const valid = z.uuid().safeParse(data.templateId).success;
    const [template] = valid
      ? await tx.select({ id: templates.id }).from(templates).where(and(eq(templates.id, data.templateId), eq(templates.type, "OFFER"), eq(templates.isActive, true)))
      : [];
    if (!template) errors.templateId = "templateId";
  }
  return errors;
}

type Locked = { application: typeof applications.$inferSelect; requisitionState: string; offers: OfferRow[] };

/** The application in `user`'s scope with its requisition state and offers, locked in the status service's order. */
async function lockApplication(tx: Tx, user: PolicyUser, applicationId: string): Promise<Locked | undefined> {
  if (!z.uuid().safeParse(applicationId).success) return undefined;
  const [found] = await tx
    .select({ requisitionId: applications.requisitionId })
    .from(applications)
    .where(and(eq(applications.id, applicationId), scopeApplicationsFor(user)));
  if (!found) return undefined;
  const [requisition] = await tx.select({ state: requisitions.state }).from(requisitions).where(eq(requisitions.id, found.requisitionId)).for("share");
  const [application] = await tx.select().from(applications).where(eq(applications.id, applicationId)).for("update");
  const rows = await tx.select().from(offers).where(eq(offers.applicationId, applicationId)).orderBy(asc(offers.createdAt), asc(offers.id)).for("update");
  return { application, requisitionState: requisition.state, offers: rows };
}

/**
 * Why "Create offer" is unavailable for this application now, or undefined;
 * the page shows it next to the disabled button. The API checks again.
 */
export async function offerCreateBlock(applicationId: string, db: Db | Tx = getDb()): Promise<CreateRefusal | undefined> {
  const [row] = await db
    .select({ status: applications.status, anonymizedAt: applications.anonymizedAt, state: requisitions.state })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(eq(applications.id, applicationId));
  if (!row) return "notInOffer";
  const existing = await db.select({ approvalStatus: offers.approvalStatus, candidateResponse: offers.candidateResponse }).from(offers).where(eq(offers.applicationId, applicationId));
  return createRefusal({ applicationStatus: row.status, anonymized: row.anonymizedAt !== null, requisitionState: row.state, offers: existing });
}

/** R10, L8: creates a DRAFT offer when every earlier offer is closed; creating it freezes them (Q6). */
export async function createOffer(tx: Tx, user: PolicyUser, applicationId: string, input: unknown, now = new Date()): Promise<OfferResult> {
  const locked = await lockApplication(tx, user, applicationId);
  if (!locked) return { ok: false, reason: "notFound" };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const errors = await validateOfferFields(tx, parsed.data, now);
  if (Object.keys(errors).length > 0) return { ok: false, reason: "invalid", fields: errors };
  const refused = createRefusal({
    applicationStatus: locked.application.status,
    anonymized: locked.application.anonymizedAt !== null,
    requisitionState: locked.requisitionState,
    offers: locked.offers,
  });
  if (refused) return { ok: false, reason: refused };

  const [offer] = await tx
    .insert(offers)
    .values({
      applicationId,
      templateId: parsed.data.templateId,
      createdByUserId: user.id,
      jobTitle: parsed.data.jobTitle.trim(),
      salary: parsed.data.salary,
      currency: parsed.data.currency,
      startDate: parsed.data.startDate,
      approvalStatus: "DRAFT",
      candidateResponse: "PENDING",
      version: 1,
    })
    .returning();
  logger.info({ offer_id: offer.id, application_id: applicationId, user_id: user.id, frozen: locked.offers.length }, "offer created");
  return { ok: true, offer };
}

/** The offer in `user`'s scope with its application locked (and its requisition FOR SHARE), or undefined. */
export async function lockOffer(tx: Tx, user: PolicyUser, offerId: string) {
  if (!z.uuid().safeParse(offerId).success) return undefined;
  const [found] = await tx.select({ applicationId: offers.applicationId }).from(offers).where(and(eq(offers.id, offerId), scopeOffersFor(user)));
  if (!found) return undefined;
  const locked = await lockApplication(tx, user, found.applicationId);
  if (!locked) return undefined;
  const offer = locked.offers.find((row) => row.id === offerId);
  return offer ? { ...locked, offer } : undefined;
}

/**
 * Edits the latest offer while DRAFT or REJECTED (§5.6, Q2, Q3); a REJECTED
 * offer stays REJECTED until it is submitted again (task 36). Optimistic
 * locking on `version` (D7, Q4).
 */
export async function updateOffer(tx: Tx, user: PolicyUser, offerId: string, input: unknown, now = new Date()): Promise<OfferResult> {
  const locked = await lockOffer(tx, user, offerId);
  if (!locked) return { ok: false, reason: "notFound" };
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const { version, approverId, ...changes } = parsed.data;
  if (isReapprovable(locked.offer, locked.offers, locked.application.status)) return changeApprovedOffer(tx, user, locked, { version, approverId, changes }, now);
  const refused = editRefusal(locked.offer, locked.offers, locked.application.status);
  if (refused) return { ok: false, reason: refused };
  const errors = await validateOfferFields(tx, changes, now, locked.offer.templateId);
  if (Object.keys(errors).length > 0) return { ok: false, reason: "invalid", fields: errors };
  if (locked.offer.version !== version) return { ok: false, reason: "stale" };

  const [offer] = await tx
    .update(offers)
    .set({ ...changes, ...(changes.jobTitle !== undefined ? { jobTitle: changes.jobTitle.trim() } : {}), version: sql`${offers.version} + 1`, updatedAt: now })
    .where(and(eq(offers.id, offerId), eq(offers.version, version)))
    .returning();
  if (!offer) return { ok: false, reason: "stale" };
  logger.info({ offer_id: offerId, user_id: user.id, version: offer.version }, "offer updated");
  return { ok: true, offer };
}

/**
 * A8 (task 36 Q2, Q9): a change to the terms of an APPROVED offer before the
 * candidate's response needs a new approver. It applies the change, sets
 * PENDING with a new submission, clears `sent_at`, writes SUBMITTED, emails
 * the approver and cancels a queued letter render (J2); the earlier letter
 * file stays (P7). Refused during L8 like a submission. A save that changes
 * nothing is a no-op.
 */
async function changeApprovedOffer(
  tx: Tx,
  user: PolicyUser,
  locked: Locked & { offer: OfferRow },
  input: { version: number; approverId?: string; changes: Partial<Record<"jobTitle" | "salary" | "currency" | "startDate" | "templateId", string>> },
  now: Date,
): Promise<OfferResult> {
  const { offer } = locked;
  const errors = await validateOfferFields(tx, input.changes, now, offer.templateId);
  if (Object.keys(errors).length > 0) return { ok: false, reason: "invalid", fields: errors };
  if (offer.version !== input.version) return { ok: false, reason: "stale" };
  const changed = changedTerms(offer, input.changes);
  if (changed.length === 0) return { ok: true, offer };
  if (input.approverId === undefined) return { ok: false, reason: "invalid", fields: { approverId: "reapprovalApproverRequired" } };
  if (locked.requisitionState !== "APPROVED") return { ok: false, reason: "submitBlocked" };
  const approver = await approverError(tx, input.approverId, user.id);
  if (approver) return { ok: false, reason: "invalid", fields: { approverId: approver } };

  const values = Object.fromEntries(changed.map((field) => [field, field === "jobTitle" ? input.changes.jobTitle!.trim() : input.changes[field]]));
  const [updated] = await tx
    .update(offers)
    .set({
      ...values,
      approvalStatus: "PENDING",
      sentAt: null,
      submittedByUserId: user.id,
      submittedAt: now,
      approverId: input.approverId,
      version: sql`${offers.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(offers.id, offer.id), eq(offers.version, input.version), eq(offers.approvalStatus, "APPROVED")))
    .returning();
  if (!updated) return { ok: false, reason: "stale" };
  await recordApprovalEvent(tx, { subjectType: "OFFER", subjectId: offer.id, event: "SUBMITTED", actorUserId: user.id, toApproverId: input.approverId });
  await queueOfferApprovalRequest(tx, offer.id);
  const cancelled = await jobQueue.cancelWaiting(tx, "offer.render-pdf", { offerId: offer.id });
  logger.info({ offer_id: offer.id, user_id: user.id, approver_id: input.approverId, fields: changed.length, cancelled_renders: cancelled }, "approved offer changed, re-approval started");
  return { ok: true, offer: updated };
}

/** §5.6 Discard offer (Q7, Q8): DRAFT or REJECTED latest offer → WITHDRAWN, audited with IDs only. */
export async function discardOffer(tx: Tx, user: PolicyUser, offerId: string, input: unknown, now = new Date()): Promise<OfferResult> {
  const locked = await lockOffer(tx, user, offerId);
  if (!locked) return { ok: false, reason: "notFound" };
  const parsed = versionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  if (!canDiscard(locked.offer, locked.offers)) return { ok: false, reason: "notDiscardable" };
  if (locked.offer.version !== parsed.data.version) return { ok: false, reason: "stale" };
  const [offer] = await tx
    .update(offers)
    .set({ approvalStatus: "WITHDRAWN", version: sql`${offers.version} + 1`, updatedAt: now })
    .where(and(eq(offers.id, offerId), eq(offers.version, parsed.data.version)))
    .returning();
  if (!offer) return { ok: false, reason: "stale" };
  await tx.insert(auditLog).values({
    actorUserId: user.id,
    action: "OFFER_DISCARDED",
    subjectType: "OFFER",
    subjectId: offerId,
    detailsJson: { applicationId: locked.application.id, fromStatus: locked.offer.approvalStatus },
  });
  logger.info({ offer_id: offerId, application_id: locked.application.id, user_id: user.id }, "offer discarded");
  return { ok: true, offer };
}

/**
 * Task 35 Q1 (owner decision): when an application becomes REJECTED or
 * WITHDRAWN, its offers still waiting for the candidate's answer are
 * withdrawn, like L6 on a close. Called by the status service in its
 * transaction; returns how many changed.
 */
export async function withdrawPendingOffers(tx: Tx, applicationId: string, now = new Date()): Promise<number> {
  const rows = await tx
    .update(offers)
    .set({ approvalStatus: "WITHDRAWN", version: sql`${offers.version} + 1`, updatedAt: now })
    .where(and(eq(offers.applicationId, applicationId), eq(offers.candidateResponse, "PENDING"), sql`${offers.approvalStatus} <> 'WITHDRAWN'`))
    .returning({ id: offers.id });
  return rows.length;
}

/** The approval view of an offer, for can() (A2, A3, A9). */
export function offerApproval(offer: Pick<OfferRow, "approvalStatus" | "approverId" | "submittedByUserId">): ApprovalResource {
  return { pending: offer.approvalStatus === "PENDING", approverId: offer.approverId, submittedByUserId: offer.submittedByUserId };
}

export type OfferListItem = OfferRow & {
  templateName: string;
  createdBy: string;
  approver: string | null;
  submitter: string | null;
  latestEvent: { event: string; actor: string | null; comment: string | null; createdAt: Date } | null;
  frozen: boolean;
  editable: boolean;
  /** A8: an edit of this approved offer needs a new approver. */
  needsReapproval: boolean;
  discardable: boolean;
  submittable: boolean;
  decidable: boolean;
  withdrawable: boolean;
  reassignable: boolean;
};

/** The application page's offers, newest first, with what the user may do with each (the API checks again). */
export async function listOffersForPage(user: PolicyUser, applicationId: string, db: Db | Tx = getDb()): Promise<OfferListItem[]> {
  if (!can(user, "offer.read")) return [];
  const approver = alias(users, "approver");
  const submitter = alias(users, "submitter");
  const rows = await db
    .select({
      offer: offers,
      templateName: templates.name,
      createdBy: users.name,
      approver: approver.name,
      submitter: submitter.name,
      applicationStatus: applications.status,
      requisitionState: requisitions.state,
    })
    .from(offers)
    .innerJoin(templates, eq(templates.id, offers.templateId))
    .innerJoin(users, eq(users.id, offers.createdByUserId))
    .innerJoin(applications, eq(applications.id, offers.applicationId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .leftJoin(approver, eq(approver.id, offers.approverId))
    .leftJoin(submitter, eq(submitter.id, offers.submittedByUserId))
    .where(and(eq(offers.applicationId, applicationId), scopeOffersFor(user)))
    .orderBy(asc(offers.createdAt), asc(offers.id));
  const all = rows.map((row) => row.offer);
  const actor = alias(users, "actor");
  const events = all.length
    ? await db
        .select({ subjectId: approvalEvents.subjectId, event: approvalEvents.event, comment: approvalEvents.comment, createdAt: approvalEvents.createdAt, actor: actor.name })
        .from(approvalEvents)
        .leftJoin(actor, eq(actor.id, approvalEvents.actorUserId))
        .where(and(eq(approvalEvents.subjectType, "OFFER"), inArray(approvalEvents.subjectId, all.map((offer) => offer.id))))
        .orderBy(asc(approvalEvents.createdAt))
    : [];
  const manage = can(user, "offer.manage");
  return rows
    .map((row) => {
      const approval = offerApproval(row.offer);
      const latest = events.filter((event) => event.subjectId === row.offer.id).at(-1);
      const reapproval = isReapprovable(row.offer, all, row.applicationStatus);
      return {
        ...row.offer,
        templateName: row.templateName,
        createdBy: row.createdBy,
        approver: row.approver,
        submitter: row.submitter,
        latestEvent: latest ? { event: latest.event, actor: latest.actor, comment: latest.comment, createdAt: latest.createdAt } : null,
        frozen: isFrozen(row.offer, all),
        editable: manage && (reapproval || editRefusal(row.offer, all, row.applicationStatus) === undefined),
        needsReapproval: reapproval,
        discardable: manage && canDiscard(row.offer, all),
        submittable: manage && submitRefusal(row.offer, all, row.applicationStatus, row.requisitionState) === undefined,
        decidable: can(user, "approval.decide", approval),
        withdrawable: can(user, "approval.withdraw", approval),
        reassignable: approval.pending && can(user, "approval.reassign"),
      };
    })
    .reverse();
}
