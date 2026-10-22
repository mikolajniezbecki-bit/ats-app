// Constraints and defaults of settings, audit_log, job_runs and rate_limits
// (ats-project-scope.md §7, tables 4 and 18–20).
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { auditLog, jobRuns, rateLimits, settings, users } from "@/server/db/schema";
import { PG, expectPgError, rolledBack, unique } from "./helpers";

describe("job_runs", () => {
  const run = (jobName: string, runDate: string) => ({ jobName, runDate, startedAt: new Date(), status: "RUNNING" as const });

  it("rejects a second run of the same job on the same date and accepts the next date", () =>
    rolledBack(async (tx) => {
      const jobName = unique("daily-purge");
      await tx.insert(jobRuns).values(run(jobName, "2026-10-22"));
      await tx.insert(jobRuns).values(run(jobName, "2026-10-23"));
      await expectPgError(tx, (sp) => sp.insert(jobRuns).values(run(jobName, "2026-10-22")), {
        code: PG.uniqueViolation,
        constraint: "job_runs_job_name_run_date_unique",
      });
    }));

  it("rejects an unknown status", () =>
    rolledBack(async (tx) => {
      await expectPgError(
        tx,
        (sp) => sp.insert(jobRuns).values({ ...run(unique("job"), "2026-10-22"), status: sql`'SKIPPED'` as never }),
        { code: PG.checkViolation, constraint: "job_runs_status_check" },
      );
    }));
});

describe("rate_limits", () => {
  it("rejects a second row for the same (key, window_start) and defaults count to 0", () =>
    rolledBack(async (tx) => {
      const key = unique("203.0.113.7");
      const windowStart = new Date("2026-10-22T10:00:00Z");
      const [row] = await tx.insert(rateLimits).values({ key, windowStart }).returning();
      expect(row.count).toBe(0);
      await expectPgError(tx, (sp) => sp.insert(rateLimits).values({ key, windowStart }), {
        code: PG.uniqueViolation,
        constraint: "rate_limits_pkey",
      });
    }));
});

describe("settings and audit_log", () => {
  it("references users and defaults details_json to {}", () =>
    rolledBack(async (tx) => {
      const [admin] = await tx
        .insert(users)
        .values({ email: `${unique("admin")}@example.com`, name: "Admin", role: "ADMIN" })
        .returning();
      await tx.insert(settings).values({ key: unique("RETENTION_DAYS"), value: "180", updatedBy: admin.id });
      const [entry] = await tx.insert(auditLog).values({ actorUserId: admin.id, action: "SETTING_CHANGED" }).returning();
      expect(entry.detailsJson).toEqual({});

      await expectPgError(
        tx,
        (sp) => sp.insert(auditLog).values({ actorUserId: "00000000-0000-4000-8000-000000000000", action: "X" }),
        { code: "23503", constraint: "audit_log_actor_user_id_users_id_fk" },
      );
    }));
});

describe("updated_at", () => {
  it("is set by Drizzle on update", async () => {
    // Outside a transaction: now() is fixed for the length of one.
    const db = getDb();
    const key = unique("updated-at");
    // An hour in the past, so the check never depends on the insert and the
    // update landing in different milliseconds (T6: it flaked in CI).
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const [created] = await db.insert(settings).values({ key, value: "1", updatedAt: past }).returning();
    expect(created.updatedAt).toEqual(past);
    const before = Date.now();
    const [updated] = await db.update(settings).set({ value: "2" }).where(eq(settings.key, key)).returning();
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(updated.createdAt).toEqual(created.createdAt);
  });
});
