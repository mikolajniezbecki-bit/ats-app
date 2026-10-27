// The hire export against the database (ats-project-scope.md §5.6 Hire
// export, R4, V10; tech-stack.md D3, T5): through the API with real session
// cookies. The worker database is shared with other files that create hires,
// so each test first drains the default export and then looks only at its
// own rows where the mode includes everything.
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/exports/hires/route";
import { POST as changeStatus } from "@/app/api/applications/[id]/status/route";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { applications, auditLog, masterData, offers, templates } from "@/server/db/schema";
import { warsawRunDate } from "@/server/domain/daily-tasks";
import { exportHires } from "@/server/exports/hires";
import { insertApplication, insertRequisition, insertUser } from "./fixtures";
import { ORIGIN, signedIn } from "./sessions";

type Session = Awaited<ReturnType<typeof signedIn>>;
const db = () => getDb() as unknown as Tx;
const HEADER = "Application ID,Requisition number,First name,Last name,Email,Phone,Job title,Department,Location,Legal entity,Start date,Salary,Currency,Hired date";

const post = (session: Session | undefined, includeExported = false) =>
  POST(
    new Request(`${ORIGIN}/api/exports/hires${includeExported ? "?includeExported=true" : ""}`, {
      method: "POST",
      headers: session ? { cookie: session.cookie } : {},
    }),
    undefined as never,
  );

/** The body as sent: `text()` would drop the byte-order mark while decoding. */
async function bodyText(response: Response): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
}

/** RFC 4180 parsing of the export, without the BOM and the final CRLF; the header row first. */
function parseCsv(text: string): string[][] {
  expect(text.startsWith("\uFEFF")).toBe(true);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const body = text.slice(1);
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\r" && body[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += char;
  }
  expect(row).toEqual([]);
  return rows;
}

async function exported(session: Session, includeExported = false) {
  const response = await post(session, includeExported);
  expect(response.status).toBe(200);
  return parseCsv(await bodyText(response));
}

/** Marks every hire currently waiting as exported, so a test's default export holds only its own rows. */
async function drain() {
  const actor = await insertUser(db(), "RECRUITER");
  await withTransaction((tx) => exportHires(tx, actor, { includeExported: false }));
}

let templateId: string | undefined;
/** A hire with an accepted offer, set by fixture (R2 holds); `exportedAt` for an earlier export. */
async function hire(overrides: Partial<typeof applications.$inferInsert> = {}, terms: { salary?: string; jobTitle?: string } = {}) {
  templateId ??= (await getDb().insert(templates).values({ type: "OFFER", name: `Offer ${randomUUID()}`, body: "Letter" }).returning())[0].id;
  const requisition = await insertRequisition(db(), { state: "APPROVED", approvedAt: new Date(), openingsCount: 5 });
  const hiredAt = overrides.hiredAt ?? new Date();
  const application = await insertApplication(db(), { requisitionId: requisition.id, status: "HIRED", hiredAt, dispositionedAt: hiredAt, ...overrides });
  const approver = await insertUser(db(), "HIRING_MANAGER");
  await getDb()
    .insert(offers)
    .values({
      applicationId: application.id,
      templateId,
      createdByUserId: approver.id,
      approverId: approver.id,
      jobTitle: terms.jobTitle ?? "Backend Engineer",
      salary: terms.salary ?? "85000",
      currency: "EUR",
      startDate: "2027-01-15",
      approvalStatus: "APPROVED",
      candidateResponse: "ACCEPTED",
      sentAt: new Date(),
      respondedAt: new Date(),
    });
  return { application, requisition };
}

async function exportedAt(ids: string[]) {
  const rows = await getDb().select({ id: applications.id, exportedAt: applications.exportedAt, version: applications.version }).from(applications).where(inArray(applications.id, ids));
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

async function latestAudit(actorUserId: string) {
  return getDb().select().from(auditLog).where(and(eq(auditLog.actorUserId, actorUserId), eq(auditLog.action, "EXPORT_HIRES"))).orderBy(desc(auditLog.createdAt));
}

describe("POST /api/exports/hires", () => {
  it("the default export contains only the new hires, oldest first, sets their exported_at, and a second one has the header row only", async () => {
    await drain();
    const recruiter = await signedIn("RECRUITER");
    const earlier = await hire({ exportedAt: new Date(Date.now() - 86_400_000) });
    const second = await hire({ hiredAt: new Date(Date.now() - 1_000), firstName: "Jan", lastName: "Kowalski, Jr." }, { jobTitle: "Data Engineer", salary: "120000.5" });
    const first = await hire({ hiredAt: new Date(Date.now() - 60_000) });
    // A deactivated department still names the hire's department.
    await getDb().update(masterData).set({ isActive: false }).where(eq(masterData.id, first.requisition.departmentId));

    const response = await post(recruiter);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="hires-${warsawRunDate(new Date())}.csv"`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const rows = parseCsv(await bodyText(response));
    expect(rows[0].join(",")).toBe(HEADER);
    expect(rows.slice(1).map((row) => row[0])).toEqual([first.application.id, second.application.id]);
    expect(rows[2]).toEqual([
      second.application.id,
      second.requisition.reqNumber,
      "Jan",
      "Kowalski, Jr.",
      second.application.email,
      "+48 123 456 789",
      "Data Engineer",
      "DEPARTMENT",
      "LOCATION",
      "LEGAL_ENTITY",
      "2027-01-15",
      "120000.50",
      "EUR",
      warsawRunDate(second.application.hiredAt!),
    ]);
    expect(rows[1][7]).toBe("DEPARTMENT");

    const after = await exportedAt([earlier.application.id, first.application.id, second.application.id]);
    expect(after[first.application.id].exportedAt).toBeInstanceOf(Date);
    expect(after[second.application.id].exportedAt).toBeInstanceOf(Date);
    expect(after[first.application.id].version).toBe(1);
    expect(after[earlier.application.id].exportedAt).toEqual(earlier.application.exportedAt);

    expect(await exported(recruiter)).toEqual([HEADER.split(",")]);
    const audits = await latestAudit(recruiter.userId);
    expect(audits.map((row) => row.detailsJson)).toEqual([
      { includeExported: false, rowCount: 0, newlyExportedCount: 0 },
      { includeExported: false, rowCount: 2, newlyExportedCount: 2 },
    ]);
    expect(audits[0].subjectType).toBeNull();
  });

  it("includeExported=true returns earlier exports with exported_at unchanged; anonymized and R4-corrected hires never appear", async () => {
    await drain();
    const admin = await signedIn("ADMIN");
    const already = await hire({ exportedAt: new Date(Date.now() - 2 * 86_400_000) });
    const fresh = await hire();
    const anonymized = await hire({
      exportedAt: new Date(Date.now() - 86_400_000),
      anonymizedAt: new Date(),
      firstName: null,
      lastName: null,
      email: null,
      emailHash: null,
      phone: null,
    });
    const corrected = await hire({ exportedAt: new Date(Date.now() - 86_400_000) });
    const correction = await changeStatus(
      new Request(`${ORIGIN}/api/applications/${corrected.application.id}/status`, {
        method: "POST",
        headers: { cookie: admin.cookie, "content-type": "application/json" },
        body: JSON.stringify({ toStatus: "WITHDRAWN", version: 1, comment: "Did not start" }),
      }),
      { params: Promise.resolve({ id: corrected.application.id }) } as never,
    );
    expect(correction.status).toBe(200);
    const ids = [already, fresh, anonymized, corrected].map((row) => row.application.id);
    const before = await exportedAt(ids);

    const all = (await exported(admin, true)).slice(1).map((row) => row[0]);
    expect(all).toEqual(expect.arrayContaining([already.application.id, fresh.application.id]));
    expect(all).not.toContain(anonymized.application.id);
    expect(all).not.toContain(corrected.application.id);
    const after = await exportedAt(ids);
    expect(after[already.application.id].exportedAt).toEqual(before[already.application.id].exportedAt);
    expect(after[fresh.application.id].exportedAt).toBeInstanceOf(Date);
    expect(after[anonymized.application.id].exportedAt).toEqual(before[anonymized.application.id].exportedAt);
    // R4 cleared it; the corrected application isn't a hire any more.
    expect(after[corrected.application.id].exportedAt).toBeNull();
    const [audit] = await latestAudit(admin.userId);
    expect(audit.detailsJson).toMatchObject({ includeExported: true, newlyExportedCount: 1 });

    const again = (await exported(admin, true)).slice(1).map((row) => row[0]);
    expect(again).toEqual(expect.arrayContaining([already.application.id, fresh.application.id]));
    expect((await exportedAt([fresh.application.id]))[fresh.application.id].exportedAt).toEqual(after[fresh.application.id].exportedAt);
    expect((await exported(admin)).length).toBe(1);
  });

  it("two concurrent default exports together contain each new hire exactly once", async () => {
    await drain();
    const [a, b] = [await signedIn("RECRUITER"), await signedIn("ADMIN")];
    const hires = [await hire(), await hire(), await hire()];
    const [first, second] = await Promise.all([exported(a), exported(b)]);
    const ids = [...first.slice(1), ...second.slice(1)].map((row) => row[0]);
    expect(ids.sort()).toEqual(hires.map((row) => row.application.id).sort());
  });

  it("V10: Hiring Manager and Interviewer get 403 and nothing changes; no session gets 401; GET isn't exported", async () => {
    await drain();
    const waiting = await hire();
    for (const role of ["HIRING_MANAGER", "INTERVIEWER"] as const) {
      const session = await signedIn(role);
      expect((await post(session)).status, role).toBe(403);
      expect(await latestAudit(session.userId), role).toEqual([]);
    }
    expect((await post(undefined)).status).toBe(401);
    expect((await exportedAt([waiting.application.id]))[waiting.application.id].exportedAt).toBeNull();
    const route = await import("@/app/api/exports/hires/route");
    expect("GET" in route).toBe(false);
    expect((await exported(await signedIn("RECRUITER"))).slice(1).map((row) => row[0])).toEqual([waiting.application.id]);
  });
});
