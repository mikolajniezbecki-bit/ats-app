// Offer rules (ats-project-scope.md §5.6, R10, L8, A8; task 35 Q2–Q7). Pure:
// the service loads the rows under its locks and asks these functions, so
// tasks 36–38 reuse them for submit, approve and the candidate's response.
import { isCurrency } from "./currencies";

export const MAX_JOB_TITLE_LENGTH = 200;
/** numeric(12,2): ten integer digits. */
export const MAX_SALARY = "9999999999.99";

export type OfferState = {
  id: string;
  createdAt: Date;
  approvalStatus: "DRAFT" | "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
  candidateResponse: "PENDING" | "ACCEPTED" | "DECLINED";
};

/** The latest offer of an application: created last, then by ID (Q6). */
export function latestOffer<T extends Pick<OfferState, "id" | "createdAt">>(offers: readonly T[]): T | undefined {
  return [...offers].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).at(-1);
}

/** Q6: every offer that isn't the latest is frozen (read-only, kept as history). */
export function isFrozen(offer: Pick<OfferState, "id">, offers: readonly Pick<OfferState, "id" | "createdAt">[]): boolean {
  return latestOffer(offers)?.id !== offer.id;
}

/** An offer that no longer blocks a new one: rejected, withdrawn or declined. */
export function isClosedOffer(offer: Pick<OfferState, "approvalStatus" | "candidateResponse">): boolean {
  return offer.approvalStatus === "REJECTED" || offer.approvalStatus === "WITHDRAWN" || offer.candidateResponse === "DECLINED";
}

export type CreateRefusal = "notInOffer" | "requisitionBlocked" | "activeOffer" | "anonymized";

/** R10, L8 and "one active offer": why a new offer can't be created now. */
export function createRefusal(input: {
  applicationStatus: string;
  anonymized: boolean;
  requisitionState: string;
  offers: readonly Pick<OfferState, "approvalStatus" | "candidateResponse">[];
}): CreateRefusal | undefined {
  if (input.anonymized) return "anonymized";
  if (input.applicationStatus !== "OFFER") return "notInOffer";
  // L8: ON_HOLD and PENDING_APPROVAL (first approval and re-approval) block creation.
  if (input.requisitionState !== "APPROVED") return "requisitionBlocked";
  if (!input.offers.every(isClosedOffer)) return "activeOffer";
  return undefined;
}

export type EditRefusal = "frozen" | "responded" | "pending" | "approved" | "withdrawn" | "notInOffer";

/**
 * Editing (§5.6, Q2, Q3, A8): only the latest offer, before the candidate's
 * response, while DRAFT or REJECTED, with the application in OFFER. L8 doesn't
 * block editing a draft.
 */
export function editRefusal(offer: OfferState, offers: readonly OfferState[], applicationStatus: string): EditRefusal | undefined {
  if (isFrozen(offer, offers)) return "frozen";
  if (offer.candidateResponse !== "PENDING") return "responded";
  if (offer.approvalStatus === "PENDING") return "pending";
  if (offer.approvalStatus === "APPROVED") return "approved";
  if (offer.approvalStatus === "WITHDRAWN") return "withdrawn";
  if (applicationStatus !== "OFFER") return "notInOffer";
  return undefined;
}

/** Discard (§5.6, Q7): only the latest offer, from DRAFT or REJECTED; works during L8. */
export function canDiscard(offer: OfferState, offers: readonly OfferState[]): boolean {
  return !isFrozen(offer, offers) && offer.candidateResponse === "PENDING" && (offer.approvalStatus === "DRAFT" || offer.approvalStatus === "REJECTED");
}

export type OfferFieldError = "jobTitle" | "salary" | "currency" | "startDate";

/** `85000`, `85000.5`, `85000.50`: greater than 0, at most 2 decimals, at most numeric(12,2). */
export function salaryValid(salary: string): boolean {
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(salary)) return false;
  return Number(salary) > 0;
}

/** Q5: the field rules. `today` is the Europe/Warsaw date of the save (YYYY-MM-DD). */
export function offerFieldErrors(
  fields: Partial<{ jobTitle: string; salary: string; currency: string; startDate: string }>,
  today: string,
): Partial<Record<OfferFieldError, true>> {
  const errors: Partial<Record<OfferFieldError, true>> = {};
  if (fields.jobTitle !== undefined) {
    const title = fields.jobTitle.trim();
    if (title.length < 1 || title.length > MAX_JOB_TITLE_LENGTH) errors.jobTitle = true;
  }
  if (fields.salary !== undefined && !salaryValid(fields.salary)) errors.salary = true;
  if (fields.currency !== undefined && !isCurrency(fields.currency)) errors.currency = true;
  if (fields.startDate !== undefined) {
    const date = new Date(`${fields.startDate}T00:00:00Z`);
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(fields.startDate) && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === fields.startDate;
    if (!valid || fields.startDate < today) errors.startDate = true;
  }
  return errors;
}

export type SubmitRefusal = "frozen" | "responded" | "notSubmittable" | "notInOffer" | "submitBlocked";

/**
 * Submitting (A1, A3, L8, Q2): the latest offer, before the candidate's
 * response, from DRAFT or (rejected, A3) REJECTED, with the application in
 * OFFER and the requisition APPROVED.
 */
export function submitRefusal(offer: OfferState, offers: readonly OfferState[], applicationStatus: string, requisitionState: string): SubmitRefusal | undefined {
  if (isFrozen(offer, offers)) return "frozen";
  if (offer.candidateResponse !== "PENDING") return "responded";
  if (offer.approvalStatus !== "DRAFT" && offer.approvalStatus !== "REJECTED") return "notSubmittable";
  if (applicationStatus !== "OFFER") return "notInOffer";
  if (requisitionState !== "APPROVED") return "submitBlocked";
  return undefined;
}

/** A8: an APPROVED latest offer before the response can change its terms through re-approval. */
export function isReapprovable(offer: OfferState, offers: readonly OfferState[], applicationStatus: string): boolean {
  return offer.approvalStatus === "APPROVED" && offer.candidateResponse === "PENDING" && !isFrozen(offer, offers) && applicationStatus === "OFFER";
}

/** The offer fields whose change needs re-approval once approved (A8, Q2). */
export const OFFER_TERMS = ["jobTitle", "salary", "currency", "startDate", "templateId"] as const;
export type OfferTerms = Record<(typeof OFFER_TERMS)[number], string>;

/** The terms that differ; salaries compare as amounts, so `85000` equals `85000.00`. */
export function changedTerms(before: OfferTerms, after: Partial<OfferTerms>): (typeof OFFER_TERMS)[number][] {
  return OFFER_TERMS.filter((field) => {
    const value = after[field];
    if (value === undefined) return false;
    if (field === "salary") return Number(value) !== Number(before.salary);
    if (field === "jobTitle") return value.trim() !== before.jobTitle;
    return value !== before[field];
  });
}
