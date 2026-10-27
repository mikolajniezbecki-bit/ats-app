// The KPI dashboard and the report exports against the database
// (ats-project-scope.md §5.9, L10, V10; tech-stack.md D6, T5). The worker
// database holds other files' requisitions and applications, so the
// dashboard test runs in a rolled-back transaction at a fixed `now` and
// compares the result before and after inserting its fixtures: counts by
// difference, averages through their sums.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET as pipelineRoute } from "@/app/api/exports/pipeline/route";
import { GET as requisitionsRoute } from "@/app/api/exports/requisitions/route";
import type { Tx } from "@/server/db";
import { auditLog } from "@/server/db/schema";
import { getDb } from "@/server/db";
import { getDashboard } from "@/server/reporting";
import { insertApplication, insertRequisition, insertUser } from "./fixtures";
import { rolledBack } from "./helpers";
import { ORIGIN, signedIn } from "./sessions";

const DAY = 86_400_000;
const now = new Date("2031-03-10T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);
const REQUISITION_HEADER =
  "Requisition number,Title,State,Close reason,Department,Location,Legal entity,Hiring manager,Recruiter,Posting type,Published,Openings,Hired,Open applications,Approved date,Closed date,Paused days,Time to fill (days),Age (days)";
const PIPELINE_HEADER = "Application ID,Requisition number,Job title,Status,Reason code,Source,Pre-screening score,Disqualified,Applied date,Disposition date,Hired date,Anonymized";

type Dashboard = NonNullable<Awaited<ReturnType<typeof getDashboard>>>;
const sum = (kpi: Dashboard["timeToFill"]) => (kpi.average ?? 0) * kpi.count;

describe("getDashboard", () => {
  it("returns the five KPIs for the fixture data (filled, cancelled, on hold, re-approval, draft; every status, hires, anonymized and corrected)", async () => {
    await rolledBack(async (tx) => {
      const admin = await insertUser(tx, "ADMIN");
      const before = (await getDashboard(admin, now, tx))!;

      // Time to Fill: 10 − 2.5 = 7.5 and 20 − 0 = 20; the cancelled one doesn't count.
      await insertRequisition(tx, { state: "CLOSED", approvedAt: daysAgo(15), closedAt: daysAgo(5), closeReason: "FILLED", pausedDays: "2.50" });
      await insertRequisition(tx, { state: "CLOSED", approvedAt: daysAgo(25), closedAt: daysAgo(5), closeReason: "FILLED", pausedDays: "0.00" });
      await insertRequisition(tx, { state: "CLOSED", approvedAt: daysAgo(25), closedAt: daysAgo(5), closeReason: "CANCELLED", pausedDays: "0.00" });
      // Age: 20 − 3 − 4 = 13.0 on hold; 30.0 in re-approval; the draft has none.
      const onHold = await insertRequisition(tx, { state: "ON_HOLD", approvedAt: daysAgo(20), pausedDays: "3.00", onHoldSince: daysAgo(4), title: `On hold ${randomUUID()}` });
      const reApproval = await insertRequisition(tx, { state: "PENDING_APPROVAL", approvedAt: daysAgo(30), title: `Re-approval ${randomUUID()}` });
      await insertRequisition(tx, { state: "DRAFT" });

      for (const status of ["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"] as const) {
        await insertApplication(tx, { requisitionId: onHold.id, status, ...(status === "REJECTED" || status === "WITHDRAWN" ? { dispositionedAt: daysAgo(1) } : {}) });
      }
      // Time to Hire: 20, 10 and the anonymized 20; the R4-corrected one (hired_at cleared) doesn't count.
      await insertApplication(tx, { requisitionId: reApproval.id, status: "HIRED", appliedAt: daysAgo(30), hiredAt: daysAgo(10), dispositionedAt: daysAgo(10) });
      await insertApplication(tx, { requisitionId: reApproval.id, status: "HIRED", appliedAt: daysAgo(15), hiredAt: daysAgo(5), dispositionedAt: daysAgo(5) });
      await insertApplication(tx, {
        requisitionId: reApproval.id,
        status: "HIRED",
        appliedAt: daysAgo(40),
        hiredAt: daysAgo(20),
        dispositionedAt: daysAgo(20),
        anonymizedAt: daysAgo(1),
        firstName: null,
        lastName: null,
        email: null,
        emailHash: null,
        phone: null,
      });
      await insertApplication(tx, { requisitionId: reApproval.id, status: "WITHDRAWN", appliedAt: daysAgo(60), hiredAt: null, dispositionedAt: daysAgo(2) });

      const after = (await getDashboard(admin, now, tx))!;
      expect(after.openRequisitions - before.openRequisitions).toBe(2);
      for (const status of ["APPLIED", "SCREENING", "INTERVIEW", "OFFER"] as const) {
        expect(after.activeByStatus[status] - before.activeByStatus[status], status).toBe(1);
      }
      expect(after.timeToFill.count - before.timeToFill.count).toBe(2);
      expect(sum(after.timeToFill) - sum(before.timeToFill)).toBeCloseTo(27.5, 6);
      expect(after.timeToHire.count - before.timeToHire.count).toBe(3);
      expect(sum(after.timeToHire) - sum(before.timeToHire)).toBeCloseTo(50, 6);
      expect(after.ages.find((row) => row.id === onHold.id)?.age).toBeCloseTo(13, 6);
      expect(after.ages.find((row) => row.id === reApproval.id)?.age).toBeCloseTo(30, 6);
      // Oldest first.
      expect(after.ages.map((row) => row.age)).toEqual([...after.ages.map((row) => row.age)].sort((a, b) => b - a));
    });
  });

  it("returns nothing without reports.view", async () => {
    await rolledBack(async (tx) => {
      for (const role of ["HIRING_MANAGER", "INTERVIEWER"] as const) expect(await getDashboard(await insertUser(tx, role), now, tx), role).toBeUndefined();
    });
  });
});

describe("GET /api/exports/requisitions and /api/exports/pipeline", () => {
  const get = (route: typeof pipelineRoute, cookie?: string) =>
    route(new Request(`${ORIGIN}/api/exports/x`, { headers: cookie ? { cookie } : {} }), undefined as never);
  const text = async (response: Response) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());

  it("V10: a Recruiter downloads both files with their header rows; nothing is audited", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await insertRequisition(getDb() as unknown as Tx, { state: "APPROVED", approvedAt: new Date(), title: `=Export ${randomUUID().slice(0, 6)}` });
    const application = await insertApplication(getDb() as unknown as Tx, { requisitionId: job.id });

    const requisitionsResponse = await get(requisitionsRoute, recruiter.cookie);
    expect(requisitionsResponse.status).toBe(200);
    expect(requisitionsResponse.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(requisitionsResponse.headers.get("content-disposition")).toMatch(/^attachment; filename="requisitions-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(requisitionsResponse.headers.get("cache-control")).toBe("no-store");
    const requisitionsCsv = await text(requisitionsResponse);
    expect(requisitionsCsv.startsWith(`\uFEFF${REQUISITION_HEADER}\r\n`)).toBe(true);
    expect(requisitionsCsv).toContain(`${job.reqNumber},'${job.title},APPROVED,`);

    const pipelineResponse = await get(pipelineRoute, recruiter.cookie);
    expect(pipelineResponse.status).toBe(200);
    expect(pipelineResponse.headers.get("content-disposition")).toMatch(/^attachment; filename="pipeline-\d{4}-\d{2}-\d{2}\.csv"$/);
    const pipelineCsv = await text(pipelineResponse);
    expect(pipelineCsv.startsWith(`\uFEFF${PIPELINE_HEADER}\r\n`)).toBe(true);
    const line = pipelineCsv.split("\r\n").find((row) => row.startsWith(application.id));
    expect(line).toBeDefined();
    expect(line).not.toContain(application.email!);
    expect(line).not.toContain(application.lastName!);

    const audits = await getDb().select().from(auditLog);
    expect(audits.filter((row) => row.actorUserId === recruiter.userId)).toEqual([]);
  });

  it("V10: Hiring Manager and Interviewer get 403 from both; no session gets 401", async () => {
    for (const role of ["HIRING_MANAGER", "INTERVIEWER"] as const) {
      const session = await signedIn(role);
      expect((await get(requisitionsRoute, session.cookie)).status, role).toBe(403);
      expect((await get(pipelineRoute, session.cookie)).status, role).toBe(403);
    }
    expect((await get(requisitionsRoute)).status).toBe(401);
    expect((await get(pipelineRoute)).status).toBe(401);
  });
});
