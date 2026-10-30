// The app login is read from DATABASE_URL (tech-stack.md G5, task 44 Q3); a
// role name that would need quoting is refused rather than escaped.
import { describe, expect, it } from "vitest";
import { appLoginFrom } from "@/server/db/app-role";

describe("appLoginFrom", () => {
  it("returns the decoded user and password", () => {
    expect(appLoginFrom("postgres://ats_app:a%2Fb-c_d@db.example:5432/ats?sslmode=require")).toEqual({
      role: "ats_app",
      password: "a/b-c_d",
    });
  });

  it.each(["postgres://Ats:pw@h/ats", "postgres://ats-app:pw@h/ats", "postgres://a%22b:pw@h/ats"])(
    "refuses the role name in %s",
    (url) => {
      expect(() => appLoginFrom(url)).toThrow("lower-case identifier");
    },
  );

  it("refuses a URL without a password, and never echoes the URL", () => {
    expect(() => appLoginFrom("postgres://ats_app@h/ats")).toThrow(/^DATABASE_URL must contain the app login's password$/);
  });
});
