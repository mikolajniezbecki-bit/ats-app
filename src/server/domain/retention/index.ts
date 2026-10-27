// The retention rule (ats-project-scope.md §5.8 RT1, RT2): which applications
// the daily purge anonymizes. Pure, so the purge's SQL selection and its
// re-check under the row lock share one definition with the unit tests.

const DAY_MS = 86_400_000;
export const FINAL_FOR_RETENTION = ["REJECTED", "WITHDRAWN", "HIRED"] as const;

/** RT2: an application dispositioned before this instant is past retention (strict `<`). */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

export type RetentionCandidate = {
  status: string;
  anonymizedAt: Date | null;
  exportedAt: Date | null;
  dispositionedAt: Date | null;
};

/**
 * RT2: not anonymized yet, in a final status (hires only once exported), and
 * `dispositioned_at + retention days < now`. An application reopened by R3 has
 * no `dispositioned_at` and is never due.
 */
export function isDueForPurge(application: RetentionCandidate, now: Date, retentionDays: number): boolean {
  if (application.anonymizedAt !== null || application.dispositionedAt === null) return false;
  if (!(FINAL_FOR_RETENTION as readonly string[]).includes(application.status)) return false;
  if (application.status === "HIRED" && application.exportedAt === null) return false;
  return application.dispositionedAt.getTime() < retentionCutoff(now, retentionDays).getTime();
}
