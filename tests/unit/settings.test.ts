// Setting values and defaults (ats-project-scope.md §5.1).
import { describe, expect, it } from "vitest";
import { SETTING_DEFINITIONS, SETTING_KEYS, parseSetting } from "@/server/settings";

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
});
