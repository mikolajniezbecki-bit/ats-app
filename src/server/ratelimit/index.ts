// The apply rate limit (ats-project-scope.md F6; tech-stack.md §3 rule 9):
// 5 attempts per client IP per hour, counted in one-minute `rate_limits`
// buckets summed over the last 60 minutes, so the window slides. Every
// attempt counts, in its own short transaction, so the count survives a
// refused or rolled-back submission. The key holds the IP, so it is never
// logged (M2).
import { and, eq, gt, sql, sum } from "drizzle-orm";
import { withTransaction } from "../db";
import { rateLimits } from "../db/schema";

export const APPLY_LIMIT = 5;
const WINDOW_MS = 60 * 60_000;

/**
 * With dev login the limit is bypassed unless the request sends
 * `x-enforce-rate-limit: true` (parallel Playwright tests); without it the
 * limit always applies and the header is ignored.
 */
export function shouldEnforceRateLimit({ authDevLogin, headerValue }: { authDevLogin: boolean; headerValue: string | null }): boolean {
  return !authDevLogin || headerValue === "true";
}

/** Counts one attempt for `key` and says whether it is within the limit. `now` is for tests. */
export async function countAttempt(key: string, now: Date = new Date()): Promise<{ allowed: boolean; count: number }> {
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  return withTransaction(async (tx) => {
    // Concurrent attempts for the same key queue here, so none slips through.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    await tx
      .insert(rateLimits)
      .values({ key, windowStart, count: 1 })
      .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1`, updatedAt: sql`now()` } });
    const [{ total }] = await tx
      .select({ total: sum(rateLimits.count) })
      .from(rateLimits)
      .where(and(eq(rateLimits.key, key), gt(rateLimits.windowStart, new Date(now.getTime() - WINDOW_MS))));
    const count = Number(total ?? 0);
    return { allowed: count <= APPLY_LIMIT, count };
  });
}
