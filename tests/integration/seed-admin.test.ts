// `pnpm seed:admin` (tech-stack.md AU8): creates, promotes or leaves the
// first Admin, and the entry point prints the user ID only.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { auditLog, users } from "@/server/db/schema";
import { seedAdmin } from "@/server/db/seed-admin";

const freshEmail = () => `seed-${randomUUID()}@tenant.onmicrosoft.com`;
const usersWith = (email: string) => getDb().select().from(users).where(eq(users.email, email));
const seededAudit = (userId: string) =>
  getDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "ADMIN_SEEDED"), eq(auditLog.subjectId, userId)));

/** Runs the real entry point, as `pnpm seed:admin` does, against this worker's database. */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", "src/server/db/seed-admin-cli.ts", ...args],
      { env: process.env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("seedAdmin", () => {
  it("creates an active Admin with a verified email and writes ADMIN_SEEDED", async () => {
    const email = freshEmail();

    const result = await seedAdmin({ email: `  ${email.toUpperCase()} ` });

    expect(result.outcome).toBe("created");
    const [row] = await usersWith(email);
    expect(row).toMatchObject({ id: result.userId, role: "ADMIN", isActive: true, emailVerified: true, image: null, name: email.split("@")[0] });
    const audit = await seededAudit(result.userId);
    expect(audit.map((a) => ({ actor: a.actorUserId, type: a.subjectType, details: a.detailsJson }))).toEqual([
      { actor: null, type: "USER", details: {} },
    ]);
  });

  it("uses --name when given", async () => {
    const email = freshEmail();
    await seedAdmin({ email, name: "Owner Admin" });
    expect((await usersWith(email))[0].name).toBe("Owner Admin");
  });

  it("a second run leaves one row and writes no second audit entry", async () => {
    const email = freshEmail();
    const first = await seedAdmin({ email });

    const second = await seedAdmin({ email });

    expect(second).toEqual({ outcome: "unchanged", userId: first.userId });
    expect(await usersWith(email)).toHaveLength(1);
    expect(await seededAudit(first.userId)).toHaveLength(1);
  });

  it("promotes a Recruiter with that email and records the previous role", async () => {
    const email = freshEmail();
    const [recruiter] = await getDb().insert(users).values({ email, name: "Rita", role: "RECRUITER" }).returning();

    const result = await seedAdmin({ email });

    expect(result).toEqual({ outcome: "updated", userId: recruiter.id });
    const [row] = await usersWith(email);
    expect(row).toMatchObject({ role: "ADMIN", isActive: true, emailVerified: true, name: "Rita" });
    expect((await seededAudit(recruiter.id)).map((a) => a.detailsJson)).toEqual([{ previousRole: "RECRUITER", wasActive: true }]);
  });

  it("reactivates an inactive Admin", async () => {
    const email = freshEmail();
    const [admin] = await getDb()
      .insert(users)
      .values({ email, name: "Old Admin", role: "ADMIN", isActive: false, emailVerified: true })
      .returning();

    expect(await seedAdmin({ email })).toEqual({ outcome: "updated", userId: admin.id });
    expect((await usersWith(email))[0].isActive).toBe(true);
    expect((await seededAudit(admin.id)).map((a) => a.detailsJson)).toEqual([{ previousRole: "ADMIN", wasActive: false }]);
  });
});

describe("seed:admin entry point", () => {
  it("prints the outcome and user ID only, never the email", async () => {
    const email = freshEmail();

    const { code, stdout, stderr } = await runCli(["--email", email, "--name", "CLI Admin"]);

    expect(code).toBe(0);
    const [row] = await usersWith(email);
    expect(stdout.trim()).toBe(`created ${row.id}`);
    expect(`${stdout}${stderr}`).not.toContain(email);
  });

  it("two concurrent runs leave one row and both exit 0", async () => {
    const email = freshEmail();

    const runs = await Promise.all([runCli(["--email", email]), runCli(["--email", email])]);

    expect(runs.map((r) => r.code)).toEqual([0, 0]);
    const rows = await usersWith(email);
    expect(rows).toHaveLength(1);
    expect(runs.map((r) => r.stdout.trim()).sort()).toEqual([`created ${rows[0].id}`, `unchanged ${rows[0].id}`]);
    expect(await seededAudit(rows[0].id)).toHaveLength(1);
  });

  it.each([[[]], [["--email"]], [["--email", "not-an-email"]], [["--mail", "x@example.com"]]])(
    "args %j print the usage, exit 1 and write nothing",
    async (args) => {
      const before = (await getDb().select().from(auditLog).where(eq(auditLog.action, "ADMIN_SEEDED"))).length;

      const { code, stdout, stderr } = await runCli(args);

      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Usage: pnpm seed:admin --email <upn>");
      expect((await getDb().select().from(auditLog).where(eq(auditLog.action, "ADMIN_SEEDED"))).length).toBe(before);
    },
  );
});
