// Setting values and defaults (ats-project-scope.md §5.1).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { SETTING_DEFINITIONS, SETTING_KEYS, parseSetting, settingsInputSchema } from "@/server/settings";

describe("settings", () => {
  it("defines every §5.1 setting with its default", () => {
    expect(Object.fromEntries(SETTING_KEYS.map((key) => [key, SETTING_DEFINITIONS[key].defaultValue]))).toEqual({
      RETENTION_DAYS: 180,
      REJECTION_EMAIL_DELAY_HOURS: 24,
      APPROVAL_REMINDER_DAYS: 3,
      MAX_UPLOAD_MB: 5,
      SENDER_EMAIL: "careers@ats-demo.local",
      FALLBACK_REPLY_TO_EMAIL: "recruiting@ats-demo.local",
      PRIVACY_STATEMENT_VERSION: "1.0",
      PRIVACY_STATEMENT_TEXT: expect.any(String),
    });
  });

  it("every default is valid for its own key", () => {
    for (const key of SETTING_KEYS) {
      expect(parseSetting(key, String(SETTING_DEFINITIONS[key].defaultValue)), key).toBe(SETTING_DEFINITIONS[key].defaultValue);
    }
  });

  it("parses integers within their allowed range only", () => {
    expect(parseSetting("MAX_UPLOAD_MB", "10")).toBe(10);
    expect(parseSetting("MAX_UPLOAD_MB", "11")).toBeUndefined();
    expect(parseSetting("MAX_UPLOAD_MB", "0")).toBeUndefined();
    expect(parseSetting("MAX_UPLOAD_MB", "2.5")).toBeUndefined();
    expect(parseSetting("RETENTION_DAYS", "3650")).toBe(3650);
    expect(parseSetting("REJECTION_EMAIL_DELAY_HOURS", "0")).toBe(0);
  });

  it("checks emails and text lengths", () => {
    expect(parseSetting("SENDER_EMAIL", "not an email")).toBeUndefined();
    expect(parseSetting("PRIVACY_STATEMENT_VERSION", "x".repeat(21))).toBeUndefined();
    expect(parseSetting("PRIVACY_STATEMENT_TEXT", "")).toBeUndefined();
  });

  it("accepts Admin input within the §5.1 allowed values and normalizes it", () => {
    expect(
      settingsInputSchema.parse({
        RETENTION_DAYS: "3650",
        REJECTION_EMAIL_DELAY_HOURS: 0,
        SENDER_EMAIL: "  Careers@Example.COM ",
        PRIVACY_STATEMENT_VERSION: " 2.0 ",
      }),
    ).toEqual({ RETENTION_DAYS: 3650, REJECTION_EMAIL_DELAY_HOURS: 0, SENDER_EMAIL: "careers@example.com", PRIVACY_STATEMENT_VERSION: "2.0" });
  });

  it.each([
    ["RETENTION_DAYS", 0],
    ["RETENTION_DAYS", 3651],
    ["REJECTION_EMAIL_DELAY_HOURS", 169],
    ["APPROVAL_REMINDER_DAYS", 0],
    ["APPROVAL_REMINDER_DAYS", 31],
    ["MAX_UPLOAD_MB", 11],
    ["MAX_UPLOAD_MB", "1.5"],
    ["SENDER_EMAIL", "nope"],
    ["FALLBACK_REPLY_TO_EMAIL", ""],
    ["PRIVACY_STATEMENT_VERSION", "   "],
    ["PRIVACY_STATEMENT_VERSION", "v".repeat(21)],
    ["PRIVACY_STATEMENT_TEXT", "x".repeat(20_001)],
  ])("refuses %s = %j", (key, value) => {
    expect(settingsInputSchema.safeParse({ [key]: value }).success).toBe(false);
  });

  it("refuses an unknown key", () => {
    const result = settingsInputSchema.safeParse({ NOT_A_SETTING: "1" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].code).toBe("unrecognized_keys");
  });

  it("RETENTION_DAYS is read only through getRetentionDays() (single reader)", () => {
    const hits = execFileSync("grep", ["-rn", "RETENTION_DAYS", "src/"], { encoding: "utf8" }).trim().split("\n");
    expect(hits.every((hit) => hit.startsWith("src/server/settings/index.ts:")), hits.join("\n")).toBe(true);
    const allowed = [/RETENTION_DAYS: \{ kind: "integer"/, /RETENTION_DAYS, read only here/, /getSetting\("RETENTION_DAYS"/];
    for (const hit of hits) expect(allowed.some((pattern) => pattern.test(hit)), hit).toBe(true);
  });
});
