// Offer drafting (ats-project-scope.md §5.6, R10, L6, L8, A8; tech-stack.md
// D3, D7, M2): create, edit and discard, with at most one active offer per
// application. Locks follow the status service's order: the requisition FOR
// SHARE, then the application FOR UPDATE (which also serializes concurrent
// creates, so "latest offer" is well defined), then the offer. The rules are
// the pure checks in domain/offers. Logs carry IDs only, never salaries,
// titles or names.
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { applications, auditLog, offers, requisitions, templates, users } from "../db/schema";
import { warsawRunDate } from "../domain/daily-tasks";
import { type CreateRefusal, type EditRefusal, canDiscard, createRefusal, editRefusal, isFrozen, offerFieldErrors } from "../domain/offers";
import { logger } from "../logger";
import { scopeApplicationsFor, scopeOffersFor } from "../policy/filters";
import { type PolicyUser, can } from "../policy/permissions";

export type OfferRow = typeof offers.$inferSelect;
export type OfferError = "invalid" | "notFound" | "stale" | "notDiscardable" | CreateRefusal | EditRefusal;
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
const updateSchema = z.object(fields).partial().extend({ version: z.number().int().min(1) }).strict();
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
async function validate(
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
  const errors = await validate(tx, parsed.data, now);
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

/** The offer in `user`'s scope with its application locked, or undefined. */
async function lockOffer(tx: Tx, user: PolicyUser, offerId: string) {
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
  const { version, ...changes } = parsed.data;
  const refused = editRefusal(locked.offer, locked.offers, locked.application.status);
  if (refused) return { ok: false, reason: refused };
  const errors = await validate(tx, changes, now, locked.offer.templateId);
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

export type OfferListItem = OfferRow & { templateName: string; createdBy: string; frozen: boolean; editable: boolean; discardable: boolean };

/** The application page's offers, newest first, with what the user may do with each (the API checks again). */
export async function listOffersForPage(user: PolicyUser, applicationId: string, db: Db | Tx = getDb()): Promise<OfferListItem[]> {
  if (!can(user, "offer.read")) return [];
  const rows = await db
    .select({ offer: offers, templateName: templates.name, createdBy: users.name, applicationStatus: applications.status })
    .from(offers)
    .innerJoin(templates, eq(templates.id, offers.templateId))
    .innerJoin(users, eq(users.id, offers.createdByUserId))
    .innerJoin(applications, eq(applications.id, offers.applicationId))
    .where(and(eq(offers.applicationId, applicationId), scopeOffersFor(user)))
    .orderBy(asc(offers.createdAt), asc(offers.id));
  const all = rows.map((row) => row.offer);
  const manage = can(user, "offer.manage");
  return rows
    .map((row) => ({
      ...row.offer,
      templateName: row.templateName,
      createdBy: row.createdBy,
      frozen: isFrozen(row.offer, all),
      editable: manage && editRefusal(row.offer, all, row.applicationStatus) === undefined,
      discardable: manage && canDiscard(row.offer, all),
    }))
    .reverse();
}
