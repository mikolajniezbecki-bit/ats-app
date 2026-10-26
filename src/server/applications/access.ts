// The facts the read rules need about one application (ats-project-scope.md
// V3a, V4, V5): its requisition's V3a columns, whether it is open and not
// anonymized, and whether the user is a current participant of one of its
// non-cancelled interviews. Used where a single record is checked with
// can() (file links); lists use the row filters in policy/filters.
import { and, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { applications, interviewParticipants, interviews, offers, requisitions } from "../db/schema";
import { isOpenStatus } from "../domain/pipeline";
import type { ApplicationResource, PolicyUser } from "../policy/permissions";

export async function applicationResource(user: PolicyUser, applicationId: string, db: Db | Tx = getDb()): Promise<ApplicationResource | undefined> {
  if (!z.uuid().safeParse(applicationId).success) return undefined;
  const [row] = await db
    .select({
      status: applications.status,
      anonymizedAt: applications.anonymizedAt,
      requisition: { hiringManagerId: requisitions.hiringManagerId, approverId: requisitions.approverId, createdByUserId: requisitions.createdByUserId },
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(eq(applications.id, applicationId));
  if (!row) return undefined;
  const [participation] = await db
    .select({ id: interviewParticipants.id })
    .from(interviewParticipants)
    .innerJoin(interviews, eq(interviews.id, interviewParticipants.interviewId))
    .where(and(eq(interviews.applicationId, applicationId), ne(interviews.status, "CANCELLED"), eq(interviewParticipants.userId, user.id), isNull(interviewParticipants.removedAt)))
    .limit(1);
  // V3b: the approver of any offer on this application (kept after decisions, §7).
  const [approval] = await db.select({ id: offers.id }).from(offers).where(and(eq(offers.applicationId, applicationId), eq(offers.approverId, user.id))).limit(1);
  return {
    requisition: row.requisition,
    open: isOpenStatus(row.status) && row.anonymizedAt === null,
    participant: participation !== undefined,
    offerApprover: approval !== undefined,
  };
}

/** The application an offer belongs to (offer letters are OFFER files). */
export async function offerApplicationId(offerId: string, db: Db | Tx = getDb()): Promise<string | undefined> {
  if (!z.uuid().safeParse(offerId).success) return undefined;
  const [row] = await db.select({ applicationId: offers.applicationId }).from(offers).where(eq(offers.id, offerId));
  return row?.applicationId;
}
