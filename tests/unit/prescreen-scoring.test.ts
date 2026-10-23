// Pre-screening scoring (ats-project-scope.md S1–S4).
import { describe, expect, it } from "vitest";
import { YES_NO_OPTIONS } from "@/server/domain/prescreen/questions";
import { InvalidAnswerError, type ScoredQuestion, scorePrescreen } from "@/server/domain/prescreen/scoring";

const opts = (...codes: string[]) => codes.map((code) => ({ code, label: code }));
const yesNo = (id: string, extra: Partial<ScoredQuestion> = {}): ScoredQuestion => ({
  id,
  questionType: "YES_NO",
  options: YES_NO_OPTIONS,
  weight: 10,
  scoringAnswer: "YES",
  disqualifyingAnswer: "NO",
  isActive: true,
  ...extra,
});
const single = (id: string, extra: Partial<ScoredQuestion> = {}): ScoredQuestion => ({
  id,
  questionType: "SINGLE",
  options: opts("A", "B", "C"),
  weight: 5,
  scoringAnswer: "A",
  disqualifyingAnswer: "C",
  isActive: true,
  ...extra,
});
const multi = (id: string, extra: Partial<ScoredQuestion> = {}): ScoredQuestion => ({
  id,
  questionType: "MULTI",
  options: opts("JS", "TS", "GO", "COBOL"),
  weight: 20,
  scoringAnswer: ["JS", "TS"],
  disqualifyingAnswer: ["COBOL"],
  isActive: true,
  ...extra,
});
const text = (id: string): ScoredQuestion => ({ id, questionType: "TEXT", options: [], weight: 0, scoringAnswer: null, disqualifyingAnswer: null, isActive: true });

describe("scorePrescreen", () => {
  it("S1: a TEXT answer gets 0 points and never disqualifies", () => {
    expect(scorePrescreen([text("t")], { t: "COBOL NO C" })).toEqual({ perQuestion: [{ questionId: "t", points: 0 }], total: 0, isDisqualified: false });
  });

  it("S2: a YES_NO answer equal to the scoring answer earns the weight, otherwise 0", () => {
    expect(scorePrescreen([yesNo("q")], { q: "YES" }).total).toBe(10);
    expect(scorePrescreen([yesNo("q", { disqualifyingAnswer: null })], { q: "NO" }).total).toBe(0);
  });

  it("S2: a YES_NO or SINGLE answer equal to the disqualifying answer disqualifies", () => {
    expect(scorePrescreen([yesNo("q")], { q: "NO" }).isDisqualified).toBe(true);
    expect(scorePrescreen([single("s")], { s: "C" })).toEqual({ perQuestion: [{ questionId: "s", points: 0 }], total: 0, isDisqualified: true });
    expect(scorePrescreen([single("s")], { s: "B" })).toEqual({ perQuestion: [{ questionId: "s", points: 0 }], total: 0, isDisqualified: false });
  });

  it("S2: a SINGLE answer equal to the scoring answer earns the weight", () => {
    expect(scorePrescreen([single("s")], { s: "A" }).total).toBe(5);
  });

  it("S2: a question with weight 0 contributes 0 even when it matches", () => {
    expect(scorePrescreen([single("s", { weight: 0, scoringAnswer: null })], { s: "A" }).total).toBe(0);
  });

  it("S3: a MULTI selection equal to the scoring set earns the weight, ignoring order and duplicates", () => {
    expect(scorePrescreen([multi("m")], { m: ["TS", "JS"] }).total).toBe(20);
    expect(scorePrescreen([multi("m")], { m: ["TS", "JS", "TS"] }).total).toBe(20);
  });

  it("S3: a subset or superset earns 0", () => {
    expect(scorePrescreen([multi("m")], { m: ["JS"] }).total).toBe(0);
    expect(scorePrescreen([multi("m")], { m: ["JS", "TS", "GO"] }).total).toBe(0);
  });

  it("S3: selecting any code of the disqualifying set disqualifies", () => {
    expect(scorePrescreen([multi("m")], { m: ["JS", "TS", "COBOL"] })).toEqual({ perQuestion: [{ questionId: "m", points: 0 }], total: 0, isDisqualified: true });
    expect(scorePrescreen([multi("m", { disqualifyingAnswer: ["GO", "COBOL"] })], { m: ["GO"] }).isDisqualified).toBe(true);
  });

  it("S4: only active questions are scored and listed; answers to inactive or unknown questions are ignored", () => {
    const result = scorePrescreen([yesNo("active"), yesNo("inactive", { isActive: false })], { active: "YES", inactive: "NO", unknown: "YES" });
    expect(result).toEqual({ perQuestion: [{ questionId: "active", points: 10 }], total: 10, isDisqualified: false });
  });

  it("S4: an unanswered question gives 0 and doesn't disqualify; an empty MULTI selection is unanswered", () => {
    expect(scorePrescreen([yesNo("q"), multi("m")], { m: [] })).toEqual({
      perQuestion: [
        { questionId: "q", points: 0 },
        { questionId: "m", points: 0 },
      ],
      total: 0,
      isDisqualified: false,
    });
  });

  it("S4: an unknown code throws InvalidAnswerError naming the question", () => {
    expect(() => scorePrescreen([single("s")], { s: "Z" })).toThrow(InvalidAnswerError);
    expect(() => scorePrescreen([multi("m")], { m: ["JS", "RUST"] })).toThrow(expect.objectContaining({ questionId: "m" }));
    expect(() => scorePrescreen([yesNo("q")], { q: "MAYBE" })).toThrow(InvalidAnswerError);
    expect(() => scorePrescreen([yesNo("q")], { q: ["YES"] })).toThrow(InvalidAnswerError);
  });

  it("S4: five questions, one inactive, sum to a known total; a disqualified result still has its total", () => {
    const questions = [yesNo("q1"), single("q2"), multi("q3"), text("q4"), single("q5", { isActive: false, weight: 50 })];
    const answers = { q1: "YES", q2: "A", q3: ["JS", "TS", "COBOL"], q4: "Hello", q5: "A" };
    expect(scorePrescreen(questions, answers)).toEqual({
      perQuestion: [
        { questionId: "q1", points: 10 },
        { questionId: "q2", points: 5 },
        { questionId: "q3", points: 0 },
        { questionId: "q4", points: 0 },
      ],
      total: 15,
      isDisqualified: true,
    });
  });
});
