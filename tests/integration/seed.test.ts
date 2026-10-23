// `db:seed` against PostgreSQL (tech-stack.md D8, AU7). Most tests run on a
// scratch database cloned from the migrated template, so the row counts
// belong to the seed alone.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, inject, it } from "vitest";
import { createAuth } from "@/server/auth/auth";
import { type AppConfig, getConfig } from "@/server/config";
import { type Db, createPool, getDb } from "@/server/db";
import * as schema from "@/server/db/schema";
import { account, auditLog, masterData, settings, templates, users } from "@/server/db/schema";
import { SeedError, runSeed } from "@/server/db/seed";
import { SEED_MASTER_DATA, SEED_TEMPLATES } from "@/server/db/seed/data";
import { withScratchDatabase } from "./database";
import { ORIGIN } from "./sessions";

const run = promisify(execFile);
const PASSWORD = "test-only-demo-password";

function seedConfig(overrides: { devLogin?: boolean; password?: string; domain?: string } = {}): AppConfig {
  const base = getConfig();
  return {
    ...base,
    auth: { ...base.auth, url: ORIGIN, devLogin: overrides.devLogin ?? false },
    demoUser: { password: overrides.password, domain: overrides.domain ?? "ats-demo.local" },
  };
}

/** Runs `fn` with a Drizzle instance on a fresh migrated (or empty) database. */
async function onScratch<T>(name: string, fn: (db: Db, url: string) => Promise<T>, fromTemplate = true): Promise<T> {
  return withScratchDatabase(inject("integrationDatabaseUrl"), name, { fromTemplate }, async (url) => {
    const pool = createPool(url, { max: 4 });
    try {
      return await fn(drizzle({ client: pool, schema }), url);
    } finally {
      await pool.end();
    }
  });
}

async function rowCounts(db: Db) {
  const count = async (table: PgTable) => (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0].n;
  return {
    users: await count(users),
    account: await count(account),
    settings: await count(settings),
    masterData: await count(masterData),
    templates: await count(templates),
    auditLog: await count(auditLog),
  };
}

describe("db:seed", () => {
  it("inserts the defaults once: a second run gives the same row counts", async () => {
    await onScratch("seed_twice", async (db) => {
      const first = await runSeed(db, seedConfig({ devLogin: true, password: PASSWORD }));
      expect(first).toMatchObject({
        settings: { inserted: 8, skipped: 0 },
        masterData: { inserted: 15, skipped: 0 },
        templates: { inserted: 6, skipped: 0 },
        users: { inserted: 4, skipped: 0 },
        passwordsSet: 4,
      });
      const counts = await rowCounts(db);
      expect(counts).toEqual({ users: 4, account: 4, settings: 8, masterData: 15, templates: 6, auditLog: 4 });

      const second = await runSeed(db, seedConfig({ devLogin: true, password: PASSWORD }));
      expect(second).toMatchObject({ settings: { inserted: 0 }, masterData: { inserted: 0 }, templates: { inserted: 0 }, users: { inserted: 0 } });
      expect(await rowCounts(db)).toEqual(counts);
    });
  });

  it("seeds settings with updated_by NULL from the getSetting() defaults, and demo users with USER_CREATED audits", async () => {
    await onScratch("seed_contents", async (db) => {
      await runSeed(db, seedConfig({ domain: "Example.ORG" }));
      const rows = await db.select().from(settings);
      expect(rows.every((row) => row.updatedBy === null)).toBe(true);
      expect(Object.fromEntries(rows.map((row) => [row.key, row.value]))).toMatchObject({ RETENTION_DAYS: "180", MAX_UPLOAD_MB: "5" });

      const demo = await db.select().from(users);
      expect(demo.map((u) => u.email).sort()).toEqual(["admin@example.org", "hm@example.org", "interviewer@example.org", "recruiter@example.org"]);
      expect(demo.every((u) => u.isActive && u.emailVerified && u.image === null)).toBe(true);
      const audits = await db.select().from(auditLog);
      expect(audits).toHaveLength(4);
      expect(audits.every((a) => a.action === "USER_CREATED" && a.actorUserId === null)).toBe(true);
      expect(audits.map((a) => (a.detailsJson as { role: string }).role).sort()).toEqual(["ADMIN", "HIRING_MANAGER", "INTERVIEWER", "RECRUITER"]);
    });
  });

  it("leaves an Admin's changes in place on a rerun", async () => {
    await onScratch("seed_admin_changes", async (db) => {
      await runSeed(db, seedConfig());
      const [admin] = await db.select().from(users).where(eq(users.email, "admin@ats-demo.local"));
      await db.update(settings).set({ value: "7", updatedBy: admin.id }).where(eq(settings.key, "APPROVAL_REMINDER_DAYS"));
      await db.update(templates).set({ body: "Edited by an Admin" }).where(eq(templates.name, "Application update"));
      await db.update(masterData).set({ isActive: false }).where(and(eq(masterData.type, "DEPARTMENT"), eq(masterData.code, "SALES")));
      await db.update(users).set({ role: "INTERVIEWER" }).where(eq(users.email, "recruiter@ats-demo.local"));

      await runSeed(db, seedConfig({ devLogin: true, password: PASSWORD }));

      expect((await db.select().from(settings).where(eq(settings.key, "APPROVAL_REMINDER_DAYS")))[0]).toMatchObject({ value: "7", updatedBy: admin.id });
      expect((await db.select().from(templates).where(eq(templates.name, "Application update")))[0].body).toBe("Edited by an Admin");
      expect((await db.select().from(masterData).where(eq(masterData.code, "SALES")))[0].isActive).toBe(false);
      expect((await db.select().from(users).where(eq(users.email, "recruiter@ats-demo.local")))[0].role).toBe("INTERVIEWER");
    });
  });

  it("skips a stage template when any EMAIL template already has its trigger status", async () => {
    await onScratch("seed_stage_skip", async (db) => {
      await runSeed(db, seedConfig());
      await db.update(templates).set({ isActive: false }).where(eq(templates.name, "Application received"));
      await db.insert(templates).values({ type: "EMAIL", name: "Our own acknowledgement", subject: "s", body: "b", triggerStatus: "APPLIED" });
      const before = await rowCounts(db);
      const result = await runSeed(db, seedConfig());
      expect(result.templates).toEqual({ inserted: 0, skipped: 6 });
      expect(await rowCounts(db)).toEqual(before);

      // Even after the seeded one is deleted, the other APPLIED template keeps it skipped.
      await db.delete(templates).where(eq(templates.name, "Application received"));
      expect((await runSeed(db, seedConfig())).templates).toEqual({ inserted: 0, skipped: 6 });
    });
  });

  it("re-inserts a seeded record an Admin deleted", async () => {
    await onScratch("seed_reinsert", async (db) => {
      await runSeed(db, seedConfig());
      await db.delete(masterData).where(and(eq(masterData.type, "LOCATION"), eq(masterData.code, "REMOTE")));
      expect((await runSeed(db, seedConfig())).masterData).toEqual({ inserted: 1, skipped: 14 });
    });
  });

  it("two concurrent runs both succeed and leave one copy of each record", async () => {
    await onScratch("seed_concurrent", async (db) => {
      const results = await Promise.all([runSeed(db, seedConfig()), runSeed(db, seedConfig())]);
      expect(results.map((r) => r.users.inserted).sort()).toEqual([0, 4]);
      expect(await rowCounts(db)).toMatchObject({ users: 4, settings: 8, masterData: 15, templates: 6 });
    });
  });

  it("refuses an unmigrated database with 'Run db:migrate first.' and writes nothing", async () => {
    await onScratch(
      "seed_unmigrated",
      async (db) => {
        await expect(runSeed(db, seedConfig())).rejects.toThrow(new SeedError("Run db:migrate first."));
        const tables = await db.execute(sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`);
        expect(tables.rows[0]).toEqual({ n: 0 });
      },
      false,
    );
  });

  it("refuses a missing or invalid DEMO_USER_DOMAIN before writing", async () => {
    await onScratch("seed_domain", async (db) => {
      for (const domain of ["", "not a domain", "localhost"]) {
        await expect(runSeed(db, { ...seedConfig(), demoUser: { password: undefined, domain: domain || undefined } })).rejects.toThrow(/DEMO_USER_DOMAIN/);
      }
      expect((await rowCounts(db)).settings).toBe(0);
    });
  });
});

describe("db:seed dev passwords (AU7)", () => {
  it("AU7: with dev login off the seed creates the four users and no account rows, ignoring a set password with a warning", async () => {
    await onScratch("seed_no_dev_login", async (db) => {
      const result = await runSeed(db, seedConfig({ devLogin: false, password: PASSWORD }));
      expect(result.users.inserted).toBe(4);
      expect(result.passwordsSet).toBe(0);
      expect(result.warnings).toEqual(["DEMO_USER_PASSWORD is ignored because AUTH_DEV_LOGIN is not true."]);
      expect(await db.select().from(account)).toEqual([]);
    });
  });

  it("AU7: with dev login on and no password the seed fails and creates no users", async () => {
    await onScratch("seed_no_password", async (db) => {
      for (const password of [undefined, "short"]) {
        await expect(runSeed(db, seedConfig({ devLogin: true, password }))).rejects.toThrow(
          "DEMO_USER_PASSWORD (12+ characters) is required when AUTH_DEV_LOGIN=true.",
        );
      }
      expect(await db.select().from(users)).toEqual([]);
    });
  });

  it("AU7: with dev login on each demo user signs in, and a rerun with a new password updates it", async () => {
    // Seeds the worker database, which the auth handler uses; the shared
    // records it adds are removed again so other tests in this worker (e.g.
    // the one-active-stage-email index tests) see the database as before.
    const domain = `seed-${Date.now()}.test`;
    const config = seedConfig({ devLogin: true, password: PASSWORD, domain });
    try {
      await runSeed(getDb(), config);
      const signIn = (email: string, password: string) =>
        createAuth(config).handler(
          new Request(`${ORIGIN}/api/auth/sign-in/email`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: ORIGIN },
            body: JSON.stringify({ email, password }),
          }),
        );
      for (const local of ["admin", "recruiter", "hm", "interviewer"]) {
        const response = await signIn(`${local}@${domain}`, PASSWORD);
        expect(response.status, local).toBe(200);
        expect(response.headers.getSetCookie().some((c) => c.startsWith("__Secure-better-auth.session_token="))).toBe(true);
      }
      await runSeed(getDb(), { ...config, demoUser: { ...config.demoUser, password: "another-test-only-password" } });
      expect((await signIn(`recruiter@${domain}`, PASSWORD)).status).toBe(401);
      expect((await signIn(`recruiter@${domain}`, "another-test-only-password")).status).toBe(200);
    } finally {
      await removeSeededSharedRecords(getDb());
    }
  });
});

/** Deletes the seeded templates, master data and default settings rows (not the users, whose domain is unique). */
async function removeSeededSharedRecords(db: Db) {
  for (const template of SEED_TEMPLATES) {
    await db.delete(templates).where(and(eq(templates.type, template.type), eq(templates.name, template.name)));
  }
  for (const record of SEED_MASTER_DATA) {
    await db
      .delete(masterData)
      .where(
        and(
          eq(masterData.type, record.type),
          eq(masterData.code, record.code),
          record.picklistKey ? eq(masterData.picklistKey, record.picklistKey) : isNull(masterData.picklistKey),
        ),
      );
  }
  await db.delete(settings).where(isNull(settings.updatedBy));
}

describe("db:seed command", () => {
  it("exits non-zero with 'Run db:migrate first.' on an unmigrated database, printing no personal data", async () => {
    await onScratch(
      "seed_cli",
      async (_db, url) => {
        const env = { ...process.env, DATABASE_URL: url, DEMO_USER_DOMAIN: "ats-demo.local", AUTH_DEV_LOGIN: "false", LOG_LEVEL: "info" };
        const result = await run(process.execPath, ["--conditions=react-server", "--import", "tsx", "src/server/db/seed/cli.ts"], { env }).then(
          () => ({ code: 0, stdout: "", stderr: "" }),
          (err: { code: number; stdout: string; stderr: string }) => err,
        );
        expect(result.code).toBe(1);
        expect(result.stdout + result.stderr).toContain("Run db:migrate first.");
      },
      false,
    );
  });
});
