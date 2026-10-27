// Offer rules (ats-project-scope.md §5.6, R10, L8, A8; task 35 Q2–Q9): the
// committed currency list, field limits and the state checks, without a
// database.
import { describe, expect, it } from "vitest";
import { canDiscard, createRefusal, editRefusal, isFrozen, latestOffer, offerFieldErrors, responseRefusal, salaryValid, type OfferState } from "@/server/domain/offers";
import { CURRENCIES, isCurrency } from "@/server/domain/offers/currencies";

const offer = (id: string, minute: number, overrides: Partial<OfferState> = {}): OfferState => ({
  id,
  createdAt: new Date(`2027-01-15T10:${String(minute).padStart(2, "0")}:00Z`),
  approvalStatus: "DRAFT",
  candidateResponse: "PENDING",
  ...overrides,
});

describe("currencies", () => {
  it("accepts active ISO 4217 codes and refuses lower case, long, unknown and non-tender codes", () => {
    for (const code of ["EUR", "PLN", "USD", "XOF", "GBP", "JPY"]) expect(isCurrency(code), code).toBe(true);
    for (const code of ["eur", "EURO", "ABC", "XXX", "XAU", "XDR", "XTS", "BOV", "USN", ""]) expect(isCurrency(code), code).toBe(false);
  });

  it("is sorted, unique and three upper-case letters each", () => {
    expect([...CURRENCIES].sort()).toEqual([...CURRENCIES]);
    expect(new Set(CURRENCIES).size).toBe(CURRENCIES.length);
    for (const code of CURRENCIES) expect(code).toMatch(/^[A-Z]{3}$/);
  });
});

describe("fields", () => {
  it("salary is greater than 0, at most 2 decimals and fits numeric(12,2)", () => {
    for (const value of ["85000", "85000.5", "85000.50", "0.01", "9999999999.99"]) expect(salaryValid(value), value).toBe(true);
    for (const value of ["0", "0.00", "-5", "1.234", "10000000000", "1e5", "85,000", "", " 1"]) expect(salaryValid(value), value).toBe(false);
  });

  it("job title 1-200 characters, start date not before today's Warsaw date", () => {
    const today = "2027-01-15";
    expect(offerFieldErrors({ jobTitle: "  ", startDate: "2027-01-14" }, today)).toEqual({ jobTitle: true, startDate: true });
    expect(offerFieldErrors({ jobTitle: "x".repeat(201) }, today)).toEqual({ jobTitle: true });
    expect(offerFieldErrors({ jobTitle: "Engineer", startDate: "2027-01-15", currency: "EUR", salary: "1" }, today)).toEqual({});
    expect(offerFieldErrors({ startDate: "2027-02-30" }, today)).toEqual({ startDate: true });
    expect(offerFieldErrors({ startDate: "2027-13-01" }, today)).toEqual({ startDate: true });
  });
});

describe("state", () => {
  it("R10, L8: an offer is created only in OFFER, on an APPROVED requisition, when every earlier offer is closed", () => {
    const base = { applicationStatus: "OFFER", anonymized: false, requisitionState: "APPROVED", offers: [] };
    expect(createRefusal(base)).toBeUndefined();
    expect(createRefusal({ ...base, applicationStatus: "INTERVIEW" })).toBe("notInOffer");
    expect(createRefusal({ ...base, requisitionState: "ON_HOLD" })).toBe("requisitionBlocked");
    expect(createRefusal({ ...base, requisitionState: "PENDING_APPROVAL" })).toBe("requisitionBlocked");
    expect(createRefusal({ ...base, offers: [offer("a", 1)] })).toBe("activeOffer");
    expect(createRefusal({ ...base, offers: [offer("a", 1, { candidateResponse: "DECLINED", approvalStatus: "APPROVED" }), offer("b", 2, { approvalStatus: "WITHDRAWN" }), offer("c", 3, { approvalStatus: "REJECTED" })] })).toBeUndefined();
    expect(createRefusal({ ...base, anonymized: true })).toBe("anonymized");
  });

  it("freezing (task 35 Q6): every offer but the latest (created last, then by ID) is frozen", () => {
    const all = [offer("b", 1), offer("a", 2), offer("c", 2)];
    expect(latestOffer(all)?.id).toBe("c");
    expect(isFrozen(all[0], all)).toBe(true);
    expect(isFrozen(all[2], all)).toBe(false);
  });

  it("§5.6, Q2, Q3, A8: editing only the latest DRAFT or REJECTED offer before a response, with the application in OFFER", () => {
    const latest = (overrides: Partial<OfferState>) => {
      const all = [offer("old", 1, { approvalStatus: "WITHDRAWN" }), offer("new", 2, overrides)];
      return editRefusal(all[1], all, "OFFER");
    };
    expect(latest({})).toBeUndefined();
    expect(latest({ approvalStatus: "REJECTED" })).toBeUndefined();
    expect(latest({ approvalStatus: "PENDING" })).toBe("pending");
    expect(latest({ approvalStatus: "APPROVED" })).toBe("approved");
    expect(latest({ approvalStatus: "WITHDRAWN" })).toBe("withdrawn");
    expect(latest({ approvalStatus: "APPROVED", candidateResponse: "ACCEPTED" })).toBe("responded");
    const all = [offer("old", 1), offer("new", 2)];
    expect(editRefusal(all[0], all, "OFFER")).toBe("frozen");
    expect(editRefusal(all[1], all, "INTERVIEW")).toBe("notInOffer");
  });

  it("discard (task 35 Q7): only the latest DRAFT or REJECTED offer, whatever the application's status", () => {
    const all = [offer("old", 1, { approvalStatus: "REJECTED" }), offer("new", 2)];
    expect(canDiscard(all[1], all)).toBe(true);
    expect(canDiscard(all[0], all)).toBe(false);
    for (const approvalStatus of ["PENDING", "APPROVED", "WITHDRAWN"] as const) {
      const one = [offer("x", 1, { approvalStatus })];
      expect(canDiscard(one[0], one), approvalStatus).toBe(false);
    }
  });

  it("§5.6 Response (task 38 Q3): once, on the latest approved offer with its letter sent, while the application is in OFFER", () => {
    const sentAt = new Date("2027-01-15T11:00:00Z");
    const sent = { ...offer("b", 2, { approvalStatus: "APPROVED" }), sentAt };
    const older = offer("a", 1, { approvalStatus: "REJECTED" });
    expect(responseRefusal(sent, [older, sent], "OFFER")).toBeUndefined();
    expect(responseRefusal({ ...older, sentAt }, [older, sent], "OFFER")).toBe("frozen");
    expect(responseRefusal({ ...sent, sentAt: null }, [sent], "OFFER")).toBe("notSent");
    expect(responseRefusal({ ...sent, approvalStatus: "PENDING", sentAt: null }, [sent], "OFFER")).toBe("notSent");
    expect(responseRefusal({ ...sent, approvalStatus: "WITHDRAWN" }, [sent], "OFFER")).toBe("notSent");
    for (const candidateResponse of ["ACCEPTED", "DECLINED"] as const) {
      expect(responseRefusal({ ...sent, candidateResponse }, [sent], "OFFER"), candidateResponse).toBe("alreadyResponded");
    }
    expect(responseRefusal(sent, [sent], "INTERVIEW")).toBe("notInOffer");
  });
});
