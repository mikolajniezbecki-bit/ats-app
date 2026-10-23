// The policy module against the database (ats-project-scope.md V1, V2, V9;
// tech-stack.md AU9, D6): row-level filters on real rows, and the route
// handler guard with real session cookies.
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAuth } from "@/server/auth/auth";
import { ensureDevUser } from "@/server/auth/dev-users";
import { type AppConfig, getConfig } from "@/server/config";
import { type Tx, getDb } from "@/server/db";
import { applications, interviewScorecards, offers, requisitions, users } from "@/server/db/schema";
import { scopeApplicationsFor, scopeOffersFor, scopeRequisitionsFor, scopeScorecardsFor } from "@/server/policy/filters";
import { withPermission } from "@/server/policy/guards";
import type { PolicyUser, Role } from "@/server/policy/permissions";
import { insertInterview, insertUser, offerValues } from "./fixtures";
import { rolledBack } from "./helpers";

/** One requisition with an application, interview, scorecard and offer. */
async function recruitingRows(tx: Tx) {
  const interview = await insertInterview(tx);
  const [application] = await tx.select().from(applications).where(eq(applications.id, interview.applicationId));
  const [scorecard] = await tx
    .insert(interviewScorecards)
    .values({ interviewId: interview.id, interviewerId: (await insertUser(tx, "INTERVIEWER")).id, overallRating: 4, thumbsUp: true })
    .returning();
  const [offer] = await tx
    .insert(offers)
    .values({ ...(await offerValues(tx)), applicationId: application.id })
    .returning();
  return { requisitionId: application.requisitionId, applicationId: application.id, scorecardId: scorecard.id, offerId: offer.id };
}

/** What `user` sees of those rows through the four filters. */
async function visible(tx: Tx, user: PolicyUser | null, rows: Awaited<ReturnType<typeof recruitingRows>>) {
  const ids = async (query: Promise<{ id: string }[]>) => (await query).map((r) => r.id);
  return {
    requisitions: await ids(
      tx.select({ id: requisitions.id }).from(requisitions).where(and(scopeRequisitionsFor(user), eq(requisitions.id, rows.requisitionId))),
    ),
    applications: await ids(
      tx.select({ id: applications.id }).from(applications).where(and(scopeApplicationsFor(user), eq(applications.id, rows.applicationId))),
    ),
    scorecards: await ids(
      tx
        .select({ id: interviewScorecards.id })
        .from(interviewScorecards)
        .where(and(scopeScorecardsFor(user), inArray(interviewScorecards.id, [rows.scorecardId]))),
    ),
    offers: await ids(tx.select({ id: offers.id }).from(offers).where(and(scopeOffersFor(user), eq(offers.id, rows.offerId)))),
  };
}

const policyUser = (role: Role, isActive = true): PolicyUser => ({ id: randomUUID(), role, isActive });

describe("row-level filters", () => {
  it("V1: Admin's scoped queries return the requisition, application, scorecard and offer", async () => {
    await rolledBack(async (tx) => {
      const rows = await recruitingRows(tx);
      expect(await visible(tx, policyUser("ADMIN"), rows)).toEqual({
        requisitions: [rows.requisitionId],
        applications: [rows.applicationId],
        scorecards: [rows.scorecardId],
        offers: [rows.offerId],
      });
    });
  });

  it("V2: Recruiter's scoped queries return all of them too", async () => {
    await rolledBack(async (tx) => {
      const rows = await recruitingRows(tx);
      expect(await visible(tx, policyUser("RECRUITER"), rows)).toEqual({
        requisitions: [rows.requisitionId],
        applications: [rows.applicationId],
        scorecards: [rows.scorecardId],
        offers: [rows.offerId],
      });
    });
  });

  it("V2: Hiring Manager, Interviewer, an inactive Recruiter and no user see none until their rules exist (D6)", async () => {
    await rolledBack(async (tx) => {
      const rows = await recruitingRows(tx);
      const none = { requisitions: [], applications: [], scorecards: [], offers: [] };
      for (const user of [policyUser("HIRING_MANAGER"), policyUser("INTERVIEWER"), policyUser("RECRUITER", false), null]) {
        expect(await visible(tx, user, rows), user?.role ?? "no user").toEqual(none);
      }
    });
  });
});

describe("withPermission", () => {
  const ORIGIN = "http://localhost:3000";
  const base = getConfig();
  const config: AppConfig = { ...base, auth: { ...base.auth, url: ORIGIN, devLogin: true } };
  const devAuth = createAuth(config);

  /** A dev user with a real session: its ID and session cookie. */
  async function signedIn(role: Role) {
    const email = `policy-${randomUUID()}@example.com`;
    const password = `pw-${randomUUID()}`;
    const userId = await ensureDevUser({ email, name: "Policy User", role, password }, config);
    const response = await devAuth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email, password }),
      }),
    );
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Secure-better-auth.session_token="))!
      .split(";")[0];
    return { userId, cookie };
  }

  // Defined in the test: no Admin-only API route exists yet (task 14).
  let reached = 0;
  const handler = withPermission("settings.manage", (_request, user) => {
    reached += 1;
    return Response.json({ ok: true, role: user.role });
  });
  const call = (cookie?: string) =>
    handler(new Request(`${ORIGIN}/api/test/settings`, { headers: cookie ? { cookie } : {} }), undefined);

  it("AU9: an authenticated Interviewer is denied with 403 by the policy module", async () => {
    const before = reached;
    const response = await call((await signedIn("INTERVIEWER")).cookie);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(reached).toBe(before);
  });

  it("AU9: no session cookie gets 401", async () => {
    const response = await call();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("AU9: an Admin reaches the handler", async () => {
    const response = await call((await signedIn("ADMIN")).cookie);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, role: "ADMIN" });
  });

  it("AU9: a user deactivated after signing in gets 401", async () => {
    const { userId, cookie } = await signedIn("ADMIN");
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, userId));

    expect((await call(cookie)).status).toBe(401);
  });
});
