// The KPI dashboard's data (ats-project-scope.md §5.9, L10; tech-stack.md
// D6): loads requisitions and applications through the row filters, after
// the reports.view check, and leaves every calculation to domain/reporting.
// Averages cover all matching records (demo volumes, task 41 Q2).
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { type Db, type Tx, getDb } from "../db";
import { applications, requisitions } from "../db/schema";
import { OPEN_STATUSES, type OpenStatus } from "../domain/pipeline";
import { ageOfRequisition, average, isOpenRequisition, timeToFill, timeToHire } from "../domain/reporting";
import { scopeApplicationsFor, scopeRequisitionsFor } from "../policy/filters";
import { type PolicyUser, can } from "../policy/permissions";

export type Dashboard = {
  openRequisitions: number;
  activeByStatus: Record<OpenStatus, number>;
  timeToFill: { average: number | null; count: number };
  timeToHire: { average: number | null; count: number };
  /** Every open requisition, oldest (largest age) first. */
  ages: { id: string; reqNumber: string; title: string; state: string; age: number }[];
};

/** The five KPIs for `user` at `now`, or undefined without `reports.view`. */
export async function getDashboard(user: PolicyUser, now = new Date(), db: Db | Tx = getDb()): Promise<Dashboard | undefined> {
  if (!can(user, "reports.view")) return undefined;
  const reqs = await db
    .select({
      id: requisitions.id,
      reqNumber: requisitions.reqNumber,
      title: requisitions.title,
      state: requisitions.state,
      approvedAt: requisitions.approvedAt,
      closedAt: requisitions.closedAt,
      closeReason: requisitions.closeReason,
      pausedDays: requisitions.pausedDays,
      onHoldSince: requisitions.onHoldSince,
    })
    .from(requisitions)
    .where(and(scopeRequisitionsFor(user), isNotNull(requisitions.approvedAt)))
    .orderBy(asc(requisitions.reqNumber));

  const active = await db
    .select({ status: applications.status, count: sql<number>`count(*)::int` })
    .from(applications)
    .where(and(scopeApplicationsFor(user), inArray(applications.status, [...OPEN_STATUSES])))
    .groupBy(applications.status);
  const hires = await db
    .select({ status: applications.status, appliedAt: applications.appliedAt, hiredAt: applications.hiredAt })
    .from(applications)
    .where(and(scopeApplicationsFor(user), eq(applications.status, "HIRED")));

  const activeByStatus = Object.fromEntries(OPEN_STATUSES.map((status) => [status, active.find((row) => row.status === status)?.count ?? 0])) as Record<OpenStatus, number>;
  const open = reqs.filter(isOpenRequisition);
  const ages = open
    .map((requisition) => ({ id: requisition.id, reqNumber: requisition.reqNumber, title: requisition.title, state: requisition.state, age: ageOfRequisition(requisition, now)! }))
    .sort((a, b) => b.age - a.age);
  return {
    openRequisitions: open.length,
    activeByStatus,
    timeToFill: average(reqs.map(timeToFill)),
    timeToHire: average(hires.map(timeToHire)),
    ages,
  };
}
