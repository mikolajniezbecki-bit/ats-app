// The synthetic demo data of `db:seed` against PostgreSQL and Azurite
// (tech-stack.md D8, ats-project-scope.md C3; task 42). Every test runs on a
// scratch database cloned from the migrated template, so the rows belong to
// the seed alone.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, inject, it } from "vitest";
import { type StorageService, getStorage } from "@/server/adapters/storage";
import { type AppConfig, getConfig } from "@/server/config";
import { type Db, createPool } from "@/server/db";
import * as schema from "@/server/db/schema";
import { runSeed } from "@/server/db/seed";
import { SYNTHETIC_LAST_NAMES } from "@/server/db/seed/synthetic-identities";
import { withScratchDatabase } from "./database";
import { ORIGIN } from "./sessions";

const now = new Date();

function seedConfig(): AppConfig {
  const base = getConfig();
  return { ...base, auth: { ...base.auth, url: ORIGIN, devLogin: false }, demoUser: { password: undefined, domain: "ats-demo.local" } };
}

async function onScratch<T>(name: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return withScratchDatabase(inject("integrationDatabaseUrl"), name, { fromTemplate: true }, async (url) => {
    const pool = createPool(url, { max: 4 });
    try {
      return await fn(drizzle({ client: pool, schema }));
    } finally {
      await pool.end();
    }
  });
}

/** The storage service, counting uploads; `failAfter` makes the upload after that many throw. */
function countingStorage(failAfter = Number.POSITIVE_INFINITY) {
  const storage = getStorage();
  const uploaded: string[] = [];
  const deleted: string[] = [];
  const wrapped: StorageService = {
    ...storage,
    upload: async (bytes, contentType) => {
      if (uploaded.length >= failAfter) throw new Error("storage unavailable");
      const result = await storage.upload(bytes, contentType);
      uploaded.push(result.key);
      return result;
    },
    delete: async (key) => {
      deleted.push(key);
      return storage.delete(key);
    },
  };
  return { storage: wrapped, uploaded, deleted };
}

const rows = async <T>(db: Db, query: ReturnType<typeof sql>) => (await db.execute(query)).rows as T[];

/** Row counts of every public table plus pg-boss jobs. */
async function allCounts(db: Db): Promise<Record<string, number>> {
  const tables = await rows<{ table_name: string }>(db, sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const counts: Record<string, number> = {};
  for (const { table_name } of tables) {
    counts[table_name] = (await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM ${sql.identifier(table_name)}`))[0].n;
  }
  counts["pgboss.job"] = (await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM pgboss.job`))[0].n;
  return counts;
}

async function blobExists(key: string): Promise<boolean> {
  try {
    await getStorage().download(key);
    return true;
  } catch {
    return false;
  }
}

describe("db:seed synthetic demo data", () => {
  it("creates every requisition state, every application status, interviews and offers, queueing nothing; a rerun is skipped", async () => {
    await onScratch("seed_synthetic", async (db) => {
      const jobsBefore = (await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM pgboss.job`))[0].n;
      const { storage, uploaded } = countingStorage();
      const result = await runSeed(db, seedConfig(), { storage, now });
      expect(result.synthetic).toMatchObject({ skipped: false });
      const counts = result.synthetic as { requisitions: number; applications: number; files: number };
      expect(counts.files).toBe(uploaded.length);

      const states = await rows<{ state: string; close_reason: string | null; re_approval: boolean; posting_type: string; is_published: boolean }>(
        db,
        sql`SELECT state, close_reason, (state = 'PENDING_APPROVAL' AND approved_at IS NOT NULL) AS re_approval, posting_type, is_published FROM requisitions`,
      );
      expect(states).toHaveLength(counts.requisitions);
      const has = (predicate: (row: (typeof states)[number]) => boolean) => states.some(predicate);
      expect(has((r) => r.state === "DRAFT")).toBe(true);
      expect(has((r) => r.state === "PENDING_APPROVAL" && !r.re_approval)).toBe(true);
      expect(has((r) => r.re_approval)).toBe(true);
      expect(has((r) => r.state === "APPROVED" && r.posting_type === "EXTERNAL" && r.is_published)).toBe(true);
      expect(has((r) => r.state === "APPROVED" && r.posting_type === "PRIVATE" && r.is_published)).toBe(true);
      expect(has((r) => r.state === "ON_HOLD" && !r.is_published)).toBe(true);
      expect(has((r) => r.state === "CLOSED" && r.close_reason === "FILLED")).toBe(true);
      expect(has((r) => r.state === "CLOSED" && r.close_reason === "CANCELLED")).toBe(true);

      const statuses = (await rows<{ status: string }>(db, sql`SELECT DISTINCT status FROM applications`)).map((r) => r.status).sort();
      expect(statuses).toEqual(["APPLIED", "HIRED", "INTERVIEW", "OFFER", "REJECTED", "SCREENING", "WITHDRAWN"]);
      const [grouped] = await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM (SELECT email_hash FROM applications GROUP BY email_hash HAVING count(*) > 1) g`);
      expect(grouped.n).toBeGreaterThanOrEqual(1);

      const [interviews] = await rows<{ future: number; past_scheduled: number; completed: number; to_fill: number }>(
        db,
        sql`SELECT count(*) FILTER (WHERE status = 'SCHEDULED' AND starts_at_utc > ${now})::int AS future,
                   count(*) FILTER (WHERE status = 'SCHEDULED' AND starts_at_utc < ${now})::int AS past_scheduled,
                   count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
                   (SELECT count(*)::int FROM interviews i JOIN interview_participants p ON p.interview_id = i.id JOIN users u ON u.id = p.user_id
                     WHERE u.email = 'interviewer@ats-demo.local' AND i.starts_at_utc < ${now}
                       AND NOT EXISTS (SELECT 1 FROM interview_scorecards s WHERE s.interview_id = i.id AND s.interviewer_id = u.id)) AS to_fill
            FROM interviews`,
      );
      expect(interviews.future).toBeGreaterThanOrEqual(1);
      expect(interviews.past_scheduled).toBeGreaterThanOrEqual(1);
      expect(interviews.completed).toBeGreaterThanOrEqual(1);
      expect(interviews.to_fill).toBeGreaterThanOrEqual(1);

      const offers = await rows<{ approval_status: string; candidate_response: string; sent: boolean; letters: number; requisition_state: string }>(
        db,
        sql`SELECT o.approval_status, o.candidate_response, o.sent_at IS NOT NULL AS sent, r.state AS requisition_state,
                   (SELECT count(*)::int FROM files f WHERE f.owner_type = 'OFFER' AND f.owner_id = o.id AND f.kind = 'OFFER_LETTER') AS letters
            FROM offers o JOIN applications a ON a.id = o.application_id JOIN requisitions r ON r.id = a.requisition_id WHERE a.status = 'OFFER'`,
      );
      expect(offers.some((o) => o.approval_status === "DRAFT")).toBe(true);
      expect(offers.some((o) => o.approval_status === "PENDING" && o.requisition_state === "APPROVED")).toBe(true);
      expect(offers.some((o) => o.approval_status === "APPROVED" && o.sent && o.candidate_response === "PENDING" && o.letters === 1)).toBe(true);

      // Nothing queued: no email_log rows and no new pg-boss jobs.
      expect((await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM email_log`))[0].n).toBe(0);
      expect((await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM pgboss.job`))[0].n).toBe(jobsBefore);

      // A rerun: skipped, no row changes anywhere, no upload.
      const before = await allCounts(db);
      const rerun = countingStorage();
      const second = await runSeed(db, seedConfig(), { storage: rerun.storage, now });
      expect(second.synthetic).toEqual({ skipped: true });
      expect(rerun.uploaded).toEqual([]);
      expect(await allCounts(db)).toEqual(before);
    });
  });

  it("C3: every seeded candidate is synthetic, and every file says so and exists in Azurite", async () => {
    await onScratch("seed_synthetic_identities", async (db) => {
      await runSeed(db, seedConfig(), { now });
      const candidates = await rows<{ last_name: string; email: string; phone: string }>(db, sql`SELECT last_name, email, phone FROM applications`);
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        expect(candidate.email).toMatch(/@example\.(com|org|net)$/);
        expect(candidate.phone.startsWith("+00")).toBe(true);
        expect(SYNTHETIC_LAST_NAMES as readonly string[]).toContain(candidate.last_name);
      }
      const files = await rows<{ storage_key: string; kind: string; status: string }>(db, sql`SELECT storage_key, kind, status FROM files`);
      for (const file of files) {
        expect(file.status).toBe("CLEAN");
        expect(await blobExists(file.storage_key), file.kind).toBe(true);
      }
      const cv = files.find((file) => file.kind === "CV")!;
      expect((await getStorage().download(cv.storage_key)).toString("latin1")).toContain("%PDF-");
    });
  });

  it("is consistent with the business rules (R5, R6, R11, L6, offers, dates within 60 days)", async () => {
    await onScratch("seed_synthetic_rules", async (db) => {
      await runSeed(db, seedConfig(), { now });
      const violations = await rows<{ rule: string; n: number }>(
        db,
        sql`SELECT * FROM (
          SELECT 'final without dispositioned_at' AS rule, count(*)::int AS n FROM applications WHERE status IN ('HIRED','REJECTED','WITHDRAWN') AND dispositioned_at IS NULL
          UNION ALL SELECT 'rejected without reason', count(*)::int FROM applications WHERE status = 'REJECTED' AND reason_code IS NULL
          UNION ALL SELECT 'hire without hired_at', count(*)::int FROM applications WHERE status = 'HIRED' AND hired_at IS NULL
          UNION ALL SELECT 'hire without exactly one accepted, sent offer with a letter', count(*)::int FROM applications a WHERE a.status = 'HIRED' AND (
            SELECT count(*) FROM offers o WHERE o.application_id = a.id AND o.candidate_response = 'ACCEPTED' AND o.approval_status = 'APPROVED' AND o.sent_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM files f WHERE f.owner_type = 'OFFER' AND f.owner_id = o.id AND f.kind = 'OFFER_LETTER')) <> 1
          UNION ALL SELECT 'hires above openings', count(*)::int FROM requisitions r WHERE (SELECT count(*) FROM applications a WHERE a.requisition_id = r.id AND a.status = 'HIRED') > r.openings_count
          UNION ALL SELECT 'filled without all openings hired', count(*)::int FROM requisitions r WHERE r.close_reason = 'FILLED' AND (SELECT count(*) FROM applications a WHERE a.requisition_id = r.id AND a.status = 'HIRED') <> r.openings_count
          UNION ALL SELECT 'filled with other than REQ_FILLED rejections', count(*)::int FROM applications a JOIN requisitions r ON r.id = a.requisition_id WHERE r.close_reason = 'FILLED' AND a.status <> 'HIRED' AND (a.status <> 'REJECTED' OR a.reason_code <> 'REQ_FILLED')
          UNION ALL SELECT 'open application on a closed requisition', count(*)::int FROM applications a JOIN requisitions r ON r.id = a.requisition_id WHERE r.state = 'CLOSED' AND a.status IN ('APPLIED','SCREENING','INTERVIEW','OFFER')
          UNION ALL SELECT 'hire on a requisition that blocks hires', count(*)::int FROM applications a JOIN requisitions r ON r.id = a.requisition_id WHERE a.status = 'HIRED' AND r.state IN ('ON_HOLD','DRAFT') AND r.approved_at IS NULL
          UNION ALL SELECT 'application without a CV', count(*)::int FROM applications a WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.owner_type = 'APPLICATION' AND f.owner_id = a.id AND f.kind = 'CV')
          UNION ALL SELECT 'application without history', count(*)::int FROM applications a WHERE NOT EXISTS (SELECT 1 FROM application_history h WHERE h.application_id = a.id AND h.from_status IS NULL)
          UNION ALL SELECT 'offer without approver', count(*)::int FROM offers WHERE approval_status NOT IN ('DRAFT','WITHDRAWN') AND approver_id IS NULL
          UNION ALL SELECT 'offer starting in the past', count(*)::int FROM offers WHERE start_date <= CURRENT_DATE
          UNION ALL SELECT 'pending requisition without SUBMITTED event', count(*)::int FROM requisitions r WHERE r.state = 'PENDING_APPROVAL' AND NOT EXISTS (SELECT 1 FROM approval_events e WHERE e.subject_type = 'REQUISITION' AND e.subject_id = r.id AND e.event = 'SUBMITTED')
          UNION ALL SELECT 'approved requisition without questions', count(*)::int FROM requisitions r WHERE r.approved_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM prescreen_questions q WHERE q.requisition_id = r.id AND q.is_active)
          UNION ALL SELECT 'closed requisition still on hold or published', count(*)::int FROM requisitions WHERE state = 'CLOSED' AND (closed_at IS NULL OR on_hold_since IS NOT NULL OR is_published)
          UNION ALL SELECT 'date older than 60 days', count(*)::int FROM applications WHERE applied_at < ${new Date(now.getTime() - 60 * 86_400_000)} OR dispositioned_at < ${new Date(now.getTime() - 60 * 86_400_000)}
        ) v WHERE n > 0`,
      );
      expect(violations).toEqual([]);
    });
  });

  it("is skipped when a requisition exists before the first run", async () => {
    await onScratch("seed_synthetic_existing", async (db) => {
      await runSeed(db, seedConfig(), { synthetic: false });
      await db.execute(sql`INSERT INTO requisitions (title, department_id, location_id, legal_entity_id, hiring_manager_id, recruiter_id, created_by_user_id, openings_count, posting_type)
        SELECT 'Made by hand', d.id, l.id, e.id, u.id, u.id, u.id, 1, 'EXTERNAL'
        FROM master_data d, master_data l, master_data e, users u
        WHERE d.type = 'DEPARTMENT' AND l.type = 'LOCATION' AND e.type = 'LEGAL_ENTITY' AND u.email = 'recruiter@ats-demo.local' LIMIT 1`);
      const { storage, uploaded } = countingStorage();
      const result = await runSeed(db, seedConfig(), { storage, now });
      expect(result.synthetic).toEqual({ skipped: true });
      expect(uploaded).toEqual([]);
      expect((await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM applications`))[0].n).toBe(0);
    });
  });

  it("two concurrent runs create one set; a failing upload rolls everything back and deletes the uploaded blobs", async () => {
    await onScratch("seed_synthetic_concurrent", async (db) => {
      const results = await Promise.all([runSeed(db, seedConfig(), { now }), runSeed(db, seedConfig(), { now })]);
      expect(results.filter((result) => result.synthetic?.skipped === true)).toHaveLength(1);
    });
    await onScratch("seed_synthetic_failure", async (db) => {
      await runSeed(db, seedConfig(), { synthetic: false });
      const before = await allCounts(db);
      const failing = countingStorage(5);
      await expect(runSeed(db, seedConfig(), { storage: failing.storage, now })).rejects.toThrow("storage unavailable");
      expect(failing.uploaded).toHaveLength(5);
      expect(failing.deleted.sort()).toEqual([...failing.uploaded].sort());
      for (const key of failing.uploaded) expect(await blobExists(key)).toBe(false);
      expect(await allCounts(db)).toEqual(before);
    });
  });
});
