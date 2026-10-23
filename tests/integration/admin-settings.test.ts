// Admin settings through the API (ats-project-scope.md §5.1, V1, T5): saves
// are validated, all or nothing, and audited with the key only (M2).
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { GET, PUT } from "@/app/api/admin/settings/route";
import { getDb } from "@/server/db";
import { auditLog, settings } from "@/server/db/schema";
import { getRetentionDays, getSetting, listSettings } from "@/server/settings";
import { ORIGIN, signedIn } from "./sessions";

// These tests commit settings rows, so each one restores the keys it touched.
const touched = new Set<string>();
afterEach(async () => {
  if (touched.size > 0) await getDb().delete(settings).where(inArray(settings.key, [...touched]));
  touched.clear();
});

function put(body: unknown, cookie?: string) {
  if (body && typeof body === "object") for (const key of Object.keys(body)) touched.add(key);
  return PUT(
    new Request(`${ORIGIN}/api/admin/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
    undefined,
  );
}

const get = (cookie?: string) => GET(new Request(`${ORIGIN}/api/admin/settings`, { headers: cookie ? { cookie } : {} }), undefined);

const auditRows = (actorUserId: string) =>
  getDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actorUserId, actorUserId), eq(auditLog.action, "SETTING_CHANGED")));

describe("PUT /api/admin/settings", () => {
  it("V1: an Admin changes REJECTION_EMAIL_DELAY_HOURS; it applies at once and is audited with the key only", async () => {
    const admin = await signedIn("ADMIN");
    expect(await getSetting("REJECTION_EMAIL_DELAY_HOURS")).toBe(24);

    const response = await put({ REJECTION_EMAIL_DELAY_HOURS: 48 }, admin.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: ["REJECTION_EMAIL_DELAY_HOURS"] });
    expect(await getSetting("REJECTION_EMAIL_DELAY_HOURS")).toBe(48);

    const rows = await auditRows(admin.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectType: "SETTING", subjectId: null, detailsJson: { key: "REJECTION_EMAIL_DELAY_HOURS" } });
    const [row] = await getDb().select().from(settings).where(eq(settings.key, "REJECTION_EMAIL_DELAY_HOURS"));
    expect(row.updatedBy).toBe(admin.userId);
  });

  it("saving the same value again writes no audit row", async () => {
    const admin = await signedIn("ADMIN");
    await put({ APPROVAL_REMINDER_DAYS: "5" }, admin.cookie);
    const second = await put({ APPROVAL_REMINDER_DAYS: 5 }, admin.cookie);
    expect(await second.json()).toEqual({ changed: [] });
    expect(await auditRows(admin.userId)).toHaveLength(1);
  });

  it("a value equal to the default with no row stored writes nothing", async () => {
    const admin = await signedIn("ADMIN");
    await getDb().delete(settings).where(eq(settings.key, "MAX_UPLOAD_MB"));
    expect(await (await put({ MAX_UPLOAD_MB: 5 }, admin.cookie)).json()).toEqual({ changed: [] });
    expect(await getDb().select().from(settings).where(eq(settings.key, "MAX_UPLOAD_MB"))).toEqual([]);
  });

  it("changing SENDER_EMAIL stores it lower-cased and no audit details contain an email", async () => {
    const admin = await signedIn("ADMIN");
    const response = await put({ SENDER_EMAIL: " Jobs@Example.ORG " }, admin.cookie);
    expect(response.status).toBe(200);
    expect(await getSetting("SENDER_EMAIL")).toBe("jobs@example.org");
    const withAt = await getDb().select().from(auditLog).where(sql`${auditLog.detailsJson}::text LIKE '%@%'`);
    expect(withAt).toEqual([]);
  });

  it("an invalid key returns 400 with field errors and saves nothing, not even the valid keys", async () => {
    const admin = await signedIn("ADMIN");
    const response = await put({ RETENTION_DAYS: 30, MAX_UPLOAD_MB: 11, SENDER_EMAIL: "nope" }, admin.cookie);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid",
      fields: { MAX_UPLOAD_MB: "Enter a whole number from 1 to 10.", SENDER_EMAIL: "Enter a valid email address." },
    });
    expect(await getRetentionDays()).toBe(180);
    expect(await auditRows(admin.userId)).toEqual([]);
  });

  it("an unknown key returns 400", async () => {
    const admin = await signedIn("ADMIN");
    const response = await put({ RETENTION_DAYS: 30, NOT_A_SETTING: 1 }, admin.cookie);
    expect(response.status).toBe(400);
    expect((await response.json()).fields).toEqual({ NOT_A_SETTING: "Unknown setting." });
    expect(await getRetentionDays()).toBe(180);
  });

  it("a changed privacy statement text without a new version is refused and saves nothing", async () => {
    const admin = await signedIn("ADMIN");
    const refused = await put({ PRIVACY_STATEMENT_TEXT: "New statement" }, admin.cookie);
    expect(refused.status).toBe(400);
    expect((await refused.json()).fields).toEqual({
      PRIVACY_STATEMENT_VERSION: "Change the version when you change the statement text.",
    });
    const sameVersion = await put({ PRIVACY_STATEMENT_TEXT: "New statement", PRIVACY_STATEMENT_VERSION: "1.0" }, admin.cookie);
    expect(sameVersion.status).toBe(400);
    expect(await getSetting("PRIVACY_STATEMENT_TEXT")).not.toBe("New statement");

    const accepted = await put({ PRIVACY_STATEMENT_TEXT: "New <b>statement</b>\nline two", PRIVACY_STATEMENT_VERSION: "2.0" }, admin.cookie);
    expect(accepted.status).toBe(200);
    expect(await getSetting("PRIVACY_STATEMENT_TEXT")).toBe("New <b>statement</b>\nline two");
    expect(await getSetting("PRIVACY_STATEMENT_VERSION")).toBe("2.0");
    expect(await auditRows(admin.userId)).toHaveLength(2);
  });

  it("getRetentionDays() returns RETENTION_DAYS, 180 by default", async () => {
    const admin = await signedIn("ADMIN");
    await getDb().delete(settings).where(eq(settings.key, "RETENTION_DAYS"));
    expect(await getRetentionDays()).toBe(180);
    await put({ RETENTION_DAYS: 90 }, admin.cookie);
    expect(await getRetentionDays()).toBe(90);
  });

  it("GET lists every setting with its effective value and the Default marker", async () => {
    const admin = await signedIn("ADMIN");
    await put({ APPROVAL_REMINDER_DAYS: 7 }, admin.cookie);
    await getDb().insert(settings).values({ key: "MAX_UPLOAD_MB", value: "6", updatedBy: null });
    touched.add("MAX_UPLOAD_MB");

    const response = await get(admin.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { settings: { key: string; value: unknown; isDefault: boolean }[] };
    const byKey = Object.fromEntries(body.settings.map((s) => [s.key, s]));
    expect(body.settings).toHaveLength(8);
    expect(byKey.APPROVAL_REMINDER_DAYS).toMatchObject({ value: 7, isDefault: false });
    // A seeded row (updated_by NULL) still counts as Default (§5.1).
    expect(byKey.MAX_UPLOAD_MB).toMatchObject({ value: 6, isDefault: true });
    expect(byKey.RETENTION_DAYS).toMatchObject({ value: 180, isDefault: true });
    expect((await listSettings()).map((s) => s.key)).toEqual(body.settings.map((s) => s.key));
  });
});

describe("settings API access (T5)", () => {
  it.each(["RECRUITER", "HIRING_MANAGER", "INTERVIEWER"] as const)("AU9: %s gets 403 from GET and PUT and nothing changes", async (role) => {
    const { cookie, userId } = await signedIn(role);
    expect((await get(cookie)).status).toBe(403);
    const response = await put({ APPROVAL_REMINDER_DAYS: 9 }, cookie);
    expect(response.status).toBe(403);
    expect(await getSetting("APPROVAL_REMINDER_DAYS")).toBe(3);
    expect(await auditRows(userId)).toEqual([]);
  });

  it("AU9: without a session GET and PUT return 401", async () => {
    expect((await get()).status).toBe(401);
    expect((await put({ APPROVAL_REMINDER_DAYS: 9 })).status).toBe(401);
    expect(await getSetting("APPROVAL_REMINDER_DAYS")).toBe(3);
  });

});
