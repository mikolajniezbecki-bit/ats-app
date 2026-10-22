// Daily tasks and the Europe/Warsaw calendar (tech-stack.md W4, W5;
// ats-project-scope.md §6). Pure: no framework, database or clock reads, so
// the time maths is unit-tested with fixed instants in any process time zone.

export const WARSAW_TIME_ZONE = "Europe/Warsaw";

/** Each daily task is a job queue, due at or after this local Warsaw hour on its run date. */
export const DAILY_TASKS = [
  { name: "retention.purge", dueHour: 2 },
  { name: "approvals.remind", dueHour: 8 },
] as const satisfies readonly { name: string; dueHour: number }[];

export type DailyTask = (typeof DAILY_TASKS)[number];
export type DailyTaskName = DailyTask["name"];

const warsawParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: WARSAW_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function partsOf(instant: Date): { date: string; hour: number } {
  const parts = Object.fromEntries(warsawParts.formatToParts(instant).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The Europe/Warsaw calendar date of `instant`, as `YYYY-MM-DD` (W5 run date). */
export function warsawRunDate(instant: Date): string {
  return partsOf(instant).date;
}

/**
 * True once the Warsaw wall clock has reached the task's hour. On the spring
 * change 02:00 doesn't exist, so a 02:00 task is due from 03:00 CEST; in
 * autumn it is due from the first 02:00 (CEST).
 */
export function isDailyTaskDue(task: DailyTask, instant: Date): boolean {
  return partsOf(instant).hour >= task.dueHour;
}

/** The tasks due at `instant`, in declaration order. */
export function dueDailyTasks(instant: Date): DailyTask[] {
  return DAILY_TASKS.filter((task) => isDailyTaskDue(task, instant));
}

/**
 * Parses a test-clock value (T3): ISO 8601 with a `Z` or an explicit offset.
 * Returns null for anything else, including a date without a time zone,
 * which would otherwise be read in the process time zone.
 */
export function parseTestNow(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
}
