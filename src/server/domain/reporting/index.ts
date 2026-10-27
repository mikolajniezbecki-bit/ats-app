// Recruiting KPIs (ats-project-scope.md §5.9, L10; task 41 Q2). Pure: the
// reporting service loads the rows and passes `now`; durations are days as
// numbers, computed from exact timestamps and `paused_days` (numeric(10,2),
// read in hundredths so "2.50" isn't a float string). Re-approval doesn't
// pause the clock (TO-10).

const DAY_MS = 86_400_000;

type State = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "ON_HOLD" | "CLOSED";

export type ReportRequisition = {
  state: State;
  approvedAt: Date | null;
  closedAt: Date | null;
  closeReason: "FILLED" | "CANCELLED" | null;
  /** numeric(10,2) as the driver returns it. */
  pausedDays: string;
  onHoldSince: Date | null;
};

export type ReportApplication = { status: string; appliedAt: Date; hiredAt: Date | null };

const days = (from: Date, to: Date) => (to.getTime() - from.getTime()) / DAY_MS;
/** `paused_days` exactly, from its decimal text. */
const paused = (value: string) => Math.round(Number(value) * 100) / 100;

/** Q2: approved at least once and not closed (APPROVED, ON_HOLD or re-approval). */
export function isOpenRequisition(requisition: Pick<ReportRequisition, "state" | "approvedAt">): boolean {
  if (requisition.state === "APPROVED" || requisition.state === "ON_HOLD") return requisition.approvedAt !== null;
  return requisition.state === "PENDING_APPROVAL" && requisition.approvedAt !== null;
}

/** L10: closed_at − approved_at − paused_days, only for FILLED; otherwise null. */
export function timeToFill(requisition: ReportRequisition): number | null {
  if (requisition.state !== "CLOSED" || requisition.closeReason !== "FILLED" || !requisition.approvedAt || !requisition.closedAt) return null;
  return days(requisition.approvedAt, requisition.closedAt) - paused(requisition.pausedDays);
}

/** L10: now − approved_at − paused_days − the current hold, for open requisitions; otherwise null. */
export function ageOfRequisition(requisition: ReportRequisition, now: Date): number | null {
  if (!isOpenRequisition(requisition) || !requisition.approvedAt) return null;
  const currentHold = requisition.state === "ON_HOLD" && requisition.onHoldSince ? days(requisition.onHoldSince, now) : 0;
  return days(requisition.approvedAt, now) - paused(requisition.pausedDays) - currentHold;
}

/** §5.9: hired_at − applied_at for HIRED applications (anonymized ones too; R4 corrections have no hired_at). */
export function timeToHire(application: ReportApplication): number | null {
  if (application.status !== "HIRED" || !application.hiredAt) return null;
  return days(application.appliedAt, application.hiredAt);
}

/** The average of the non-null values with their count; `average` is null for none. */
export function average(values: readonly (number | null)[]): { average: number | null; count: number } {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return { average: null, count: 0 };
  return { average: present.reduce((sum, value) => sum + value, 0) / present.length, count: present.length };
}

/** Q2: days with one decimal, rounded half up; null is "—". */
export function formatDays(value: number | null): string {
  if (value === null) return "—";
  return (Math.floor(value * 10 + 0.5 + 1e-9) / 10).toFixed(1);
}
