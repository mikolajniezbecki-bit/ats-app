// Synthetic candidates (ats-project-scope.md C3; task 42 Q5): nothing the
// demo seed can create resembles a real person.
import { describe, expect, it } from "vitest";
import { SYNTHETIC_LAST_NAMES, syntheticCandidate } from "@/server/db/seed/synthetic-identities";

describe("syntheticCandidate", () => {
  it("uses reserved email domains, +00 phone numbers and the fictitious last names only", () => {
    const candidates = Array.from({ length: 99 }, (_, n) => syntheticCandidate(n));
    for (const candidate of candidates) {
      expect(candidate.email, candidate.email).toMatch(/@example\.(com|org|net)$/);
      expect(candidate.phone, candidate.phone).toMatch(/^\+00 000 000 0\d\d$/);
      // §7: digits, spaces and + - ( ) only.
      expect(candidate.phone).toMatch(/^[0-9 +\-()]+$/);
      expect(SYNTHETIC_LAST_NAMES).toContain(candidate.lastName);
    }
    expect(new Set(candidates.map((candidate) => candidate.email)).size).toBe(candidates.length);
  });

  it("is deterministic", () => {
    expect(syntheticCandidate(0)).toEqual({ firstName: "Ada", lastName: "Sample", email: "ada.sample.01@example.com", phone: "+00 000 000 001" });
    expect(syntheticCandidate(7)).toEqual(syntheticCandidate(7));
  });
});
