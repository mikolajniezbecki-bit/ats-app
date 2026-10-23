// Pre-screening question rules (ats-project-scope.md §5.3 "Question rules", S1).
import { describe, expect, it } from "vitest";
import { validateQuestion } from "@/server/domain/prescreen/questions";

const options = [
  { code: "A", label: "Alpha" },
  { code: "B", label: "Beta" },
  { code: "C", label: "Gamma" },
];
const errors = (input: Record<string, unknown>) => {
  const result = validateQuestion(input);
  return result.ok ? {} : result.errors;
};

describe("validateQuestion", () => {
  it("YES_NO gets the fixed options from the server", () => {
    const result = validateQuestion({ questionText: " Do you have a permit? ", questionType: "YES_NO", weight: 10, scoringAnswer: "YES", disqualifyingAnswer: "NO" });
    expect(result).toMatchObject({
      ok: true,
      question: { questionText: "Do you have a permit?", options: [{ code: "YES", label: "Yes" }, { code: "NO", label: "No" }] },
    });
  });

  it("YES_NO with the same scoring and disqualifying answer is rejected", () => {
    expect(errors({ questionText: "Q", questionType: "YES_NO", weight: 5, scoringAnswer: "YES", disqualifyingAnswer: "YES" })).toEqual({
      disqualifyingAnswer: "answersEqual",
    });
  });

  it("a SINGLE scoring answer that isn't an option is rejected", () => {
    expect(errors({ questionText: "Q", questionType: "SINGLE", options, weight: 5, scoringAnswer: "Z" })).toEqual({ scoringAnswer: "answerCode" });
  });

  it("MULTI scoring and disqualifying sets that overlap are rejected", () => {
    expect(errors({ questionText: "Q", questionType: "MULTI", options, weight: 5, scoringAnswer: ["A", "B"], disqualifyingAnswer: ["B"] })).toEqual({
      disqualifyingAnswer: "answersOverlap",
    });
    expect(validateQuestion({ questionText: "Q", questionType: "MULTI", options, weight: 5, scoringAnswer: ["B", "A"], disqualifyingAnswer: ["C"] }).ok).toBe(true);
  });

  it("MULTI answers are non-empty sets", () => {
    expect(errors({ questionText: "Q", questionType: "MULTI", options, weight: 5, scoringAnswer: [] })).toEqual({ scoringAnswer: "answerSet" });
    expect(errors({ questionText: "Q", questionType: "MULTI", options, weight: 5, scoringAnswer: "A" })).toEqual({ scoringAnswer: "answerSet" });
  });

  it("a duplicate option code is rejected; codes follow the pattern", () => {
    expect(errors({ questionText: "Q", questionType: "SINGLE", options: [...options, { code: "A", label: "Again" }] })).toEqual({ options: "duplicateCode" });
    expect(errors({ questionText: "Q", questionType: "SINGLE", options: [{ code: "a b", label: "x" }, ...options] })).toEqual({ options: "optionCode" });
  });

  it("SINGLE and MULTI need 2 to 20 options", () => {
    expect(errors({ questionText: "Q", questionType: "SINGLE", options: [options[0]] })).toEqual({ options: "optionCount" });
    const many = Array.from({ length: 21 }, (_, i) => ({ code: `O${i}`, label: `Option ${i}` }));
    expect(errors({ questionText: "Q", questionType: "MULTI", options: many })).toEqual({ options: "optionCount" });
  });

  it("weight 101 is rejected, and weight and scoring answer go together", () => {
    expect(errors({ questionText: "Q", questionType: "YES_NO", weight: 101, scoringAnswer: "YES" })).toEqual({ weight: "invalid" });
    expect(errors({ questionText: "Q", questionType: "YES_NO", weight: 10 })).toEqual({ weight: "weightNeedsAnswer" });
    expect(errors({ questionText: "Q", questionType: "YES_NO", weight: 0, scoringAnswer: "YES" })).toEqual({ weight: "weightNeedsAnswer" });
    expect(validateQuestion({ questionText: "Q", questionType: "YES_NO", weight: 0, disqualifyingAnswer: "NO" }).ok).toBe(true);
  });

  it("question text is 1 to 500 characters", () => {
    expect(errors({ questionText: "  ", questionType: "TEXT" })).toEqual({ questionText: "invalid" });
    expect(errors({ questionText: "x".repeat(501), questionType: "TEXT" })).toEqual({ questionText: "invalid" });
  });

  it("S1: a TEXT question is saved with weight 0, no options and no answers", () => {
    expect(validateQuestion({ questionText: "Tell us about you", questionType: "TEXT" })).toMatchObject({
      ok: true,
      question: { options: [], weight: 0, scoringAnswer: null, disqualifyingAnswer: null },
    });
  });

  it("S1: a TEXT question with a weight is rejected", () => {
    expect(errors({ questionText: "Q", questionType: "TEXT", weight: 5 })).toEqual({ weight: "textNoWeight" });
  });

  it("S1: a TEXT question with a scoring or disqualifying answer is rejected", () => {
    expect(errors({ questionText: "Q", questionType: "TEXT", scoringAnswer: "x" })).toEqual({ scoringAnswer: "textNoAnswer" });
    expect(errors({ questionText: "Q", questionType: "TEXT", disqualifyingAnswer: "x" })).toEqual({ disqualifyingAnswer: "textNoAnswer" });
  });

  it("S1: a TEXT question with options is rejected", () => {
    expect(errors({ questionText: "Q", questionType: "TEXT", options })).toEqual({ options: "textNoOptions" });
  });

  it("unknown keys are refused", () => {
    expect(errors({ questionText: "Q", questionType: "TEXT", requisitionId: "x" })).toEqual({ requisitionId: "notAllowed" });
  });
});
