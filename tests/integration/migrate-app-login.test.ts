// db:migrate with DATABASE_ADMIN_URL (tech-stack.md G5, task 44 Q3): the admin
// applies the migrations and creates the least-privilege app login, which can
// then do DML and use the job queue but no DDL on `public`.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { ensureJobQueues, inspectJobQueues, jobQueue } from "@/server/adapters/job-queue";
import { createPool } from "@/server/db";
import { rootCause } from "@/server/db/migrator";
import * as schema from "@/server/db/schema";
import { applications } from "@/server/db/schema";
import { quoteIdent, withAdminClient, withScratchDatabase } from "./database";
import { insertApplication } from "./fixtures";

const run = promisify(execFile);
const baseUrl = inject("integrationDatabaseUrl");
// Roles are per server, so each Vitest worker uses its own.
const APP_ROLE = `ats_app_t${process.env.VITEST_POOL_ID ?? "1"}`;
const PASSWORD = randomBytes(24).toString("base64url");
const INSUFFICIENT_PRIVILEGE = "42501";

function appUrlFor(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = APP_ROLE;
  url.password = PASSWORD;
  return url.toString();
}

async function migrate(adminUrl: string): Promise<{ code: number; output: string }> {
  const env = { ...process.env, DATABASE_URL: appUrlFor(adminUrl), DATABASE_ADMIN_URL: adminUrl, LOG_LEVEL: "info" };
  return run(process.execPath, ["--conditions=react-server", "--import", "tsx", "src/server/db/migrate.ts"], { env }).then(
    ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
    (err: { code: number; stdout: string; stderr: string }) => ({ code: err.code, output: err.stdout + err.stderr }),
  );
}

const dropRole = () => withAdminClient(baseUrl, (client) => client.query(`DROP ROLE IF EXISTS ${quoteIdent(APP_ROLE)}`));

beforeAll(dropRole);
afterAll(dropRole);

describe("db:migrate with DATABASE_ADMIN_URL", () => {
  it("creates the app login with DML and job-queue rights only, and a second run changes nothing", async () => {
    await withScratchDatabase(baseUrl, "app_login", { fromTemplate: false }, async (adminUrl) => {
      const first = await migrate(adminUrl);
      expect(first.code, first.output).toBe(0);
      // Never the password or a connection string in the output.
      expect(first.output).not.toContain(PASSWORD);

      const admin = createPool(adminUrl, { max: 1 });
      const app = createPool(appUrlFor(adminUrl), { max: 2 });
      try {
        const owners = await admin.query<{ schema_owner: string; job_owner: string }>(
          `SELECT pg_get_userbyid(n.nspowner) AS schema_owner, pg_get_userbyid(c.relowner) AS job_owner
             FROM pg_namespace n JOIN pg_class c ON c.relnamespace = n.oid
            WHERE n.nspname = 'pgboss' AND c.relname = 'job'`,
        );
        expect(owners.rows).toEqual([{ schema_owner: APP_ROLE, job_owner: APP_ROLE }]);
        const migrations = await admin.query("SELECT id FROM drizzle.__drizzle_migrations");

        // DML on the application tables, including req_number_seq.
        const db = drizzle({ client: app, schema });
        await db.transaction(async (tx) => {
          const application = await insertApplication(tx);
          await tx.update(applications).set({ prescreenScore: 4 }).where(eq(applications.id, application.id));
          // The job queue: the INSERT into pgboss.job runs in this transaction, as the app login.
          const jobId = await jobQueue.enqueue(tx, "email.send", { emailId: application.id });
          const job = await tx.execute(sql`SELECT name FROM pgboss.job WHERE id = ${jobId}`);
          expect(job.rows).toEqual([{ name: "email.send" }]);
        });
        await ensureJobQueues({ pool: app });
        expect((await inspectJobQueues({ pool: app })).length).toBeGreaterThan(0);

        // No DDL: not on public, and the CREATE right on the database is gone again.
        for (const statement of ["CREATE TABLE public.x (id int)", "DROP TABLE users", "CREATE SCHEMA y"]) {
          const error = await app.query(statement).then(
            () => undefined,
            (err: unknown) => err,
          );
          expect((rootCause(error) as { code?: string } | undefined)?.code, statement).toBe(INSUFFICIENT_PRIVILEGE);
        }

        const second = await migrate(adminUrl);
        expect(second.code, second.output).toBe(0);
        expect((await admin.query("SELECT id FROM drizzle.__drizzle_migrations")).rows).toEqual(migrations.rows);
        // The app login still connects with the same password.
        expect((await app.query("SELECT current_user AS user")).rows).toEqual([{ user: APP_ROLE }]);
      } finally {
        await Promise.all([admin.end(), app.end()]);
      }
    });
  });
});
