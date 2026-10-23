// Quick Apply input rules (ats-project-scope.md §5.3, §7 `applications`
// limits, F7).
import { describe, expect, it } from "vitest";
import { applicantSchema, computeEmailHash, parseAnswers } from "@/server/domain/apply";

const valid = { firstName: "Łucja", lastName: "Żółć", email: "ann@example.com", phone: "+48 (600) 100-200", consent: true as const };

describe("computeEmailHash", () => {
  it("F7: is 64 lower-case hex characters of the trimmed, lower-cased email, and depends on the key", () => {
    const hash = computeEmailHash(" Ann@Example.COM ", "key-1");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(computeEmailHash("ann@example.com", "key-1"));
    expect(hash).not.toBe(computeEmailHash("ann@example.com", "key-2"));
  });
});

describe("applicantSchema", () => {
  it("accepts Unicode names unchanged and trims the fields", () => {
    expect(applicantSchema.parse({ ...valid, firstName: " Łucja " })).toMatchObject({ firstName: "Łucja", lastName: "Żółć" });
  });

  it("names are 1–100 characters; email at most 254; consent must be given", () => {
    expect(applicantSchema.safeParse({ ...valid, firstName: "" }).success).toBe(false);
    expect(applicantSchema.safeParse({ ...valid, lastName: "x".repeat(101) }).success).toBe(false);
    expect(applicantSchema.safeParse({ ...valid, email: `${"a".repeat(250)}@x.io` }).success).toBe(false);
    expect(applicantSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
    expect(applicantSchema.safeParse({ ...valid, consent: false }).success).toBe(false);
  });

  it("phone: 6–30 characters of digits, spaces and + - ( ), with at least 6 digits", () => {
    for (const phone of ["123456", "+48 600 100 200", "(0) 12-34-56"]) expect(applicantSchema.safeParse({ ...valid, phone }).success, phone).toBe(true);
    for (const phone of ["12345", "+48 (12) 3", "600 100 200 ext", "1".repeat(31), "+++---((())))"]) {
      expect(applicantSchema.safeParse({ ...valid, phone }).success, phone).toBe(false);
    }
  });
});

describe("parseAnswers", () => {
  const questions = [
    { id: "yn", questionType: "YES_NO" as const, options: [{ code: "YES" }, { code: "NO" }] },
    { id: "single", questionType: "SINGLE" as const, options: [{ code: "A" }, { code: "B" }] },
    { id: "multi", questionType: "MULTI" as const, options: [{ code: "X" }, { code: "Y" }] },
    { id: "text", questionType: "TEXT" as const, options: [] },
  ];

  it("YES_NO and SINGLE are required; MULTI and TEXT are optional and empty means unanswered", () => {
    expect(parseAnswers(questions, { yn: ["YES"], single: ["B"], multi: [], text: [" "] })).toEqual({ answers: { yn: "YES", single: "B" }, errors: {} });
    expect(parseAnswers(questions, {}).errors).toEqual({ "answers.yn": "answerRequired", "answers.single": "answerRequired" });
  });

  it("answers use the question's own codes", () => {
    expect(parseAnswers(questions, { yn: ["MAYBE"], single: ["A", "B"], multi: ["Z"] }).errors).toEqual({
      "answers.yn": "invalidOption",
      "answers.single": "invalidOption",
      "answers.multi": "invalidOption",
    });
    expect(parseAnswers(questions, { yn: ["NO"], single: ["A"], unknown: ["x"] }).errors).toEqual({ "answers.unknown": "unknownQuestion" });
  });

  it("MULTI keeps the selected codes once; TEXT is at most 2,000 characters", () => {
    expect(parseAnswers(questions, { yn: ["NO"], single: ["A"], multi: ["Y", "X", "Y"] }).answers.multi).toEqual(["Y", "X"]);
    expect(parseAnswers(questions, { yn: ["NO"], single: ["A"], text: ["x".repeat(2001)] }).errors).toEqual({ "answers.text": "textTooLong" });
  });
});
