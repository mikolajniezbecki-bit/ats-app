// Maps an offer result to the JSON response the forms read: an error code,
// its text from messages/en.json, and per-field texts for 400s.
import { message } from "@/server/messages";
import type { OfferApprovalError, OfferApprovalResult } from "@/server/approvals/offers";
import type { OfferError, OfferResult } from "@/server/offers";

const STATUS: Record<OfferError | OfferApprovalError, number> = {
  forbidden: 403,
  notPending: 409,
  notSubmittable: 409,
  submitBlocked: 409,
  approveBlocked: 409,
  invalid: 400,
  notFound: 404,
  stale: 409,
  notDiscardable: 409,
  notInOffer: 409,
  requisitionBlocked: 409,
  activeOffer: 409,
  anonymized: 409,
  frozen: 409,
  responded: 409,
  pending: 409,
  approved: 409,
  withdrawn: 409,
  alreadyResponded: 409,
  notSent: 409,
};

function fieldText(code: string): string {
  try {
    return message(`Offers.errors.fields.${code}`);
  } catch {
    return message("Offers.errors.fields.invalid");
  }
}

export function offerResponse(result: OfferResult | OfferApprovalResult, okStatus = 200): Response {
  if (result.ok) return Response.json({ offer: result.offer }, { status: okStatus });
  const body: { error: string; message: string; fields?: Record<string, string> } = { error: result.reason, message: message(`Offers.errors.${result.reason}`) };
  if (result.fields) body.fields = Object.fromEntries(Object.entries(result.fields).map(([field, code]) => [field, fieldText(code)]));
  return Response.json(body, { status: STATUS[result.reason] });
}
