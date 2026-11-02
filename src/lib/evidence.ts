import { INSUFFICIENT_EVIDENCE, type Outcome, type Reason } from "@/lib/reasons";
import type { ModelInput } from "@/lib/redact";

// The evidence a diagnosis lacked, derived by code from the sections the
// model input marks `available: false`. Never written by the model: it is a
// fact about our pipeline, not a judgement about the buyer.

export const EVIDENCE_GAPS = ["behaviour_trail", "checkout_log", "card_details"] as const;
export type EvidenceGap = (typeof EVIDENCE_GAPS)[number];

// Order is fixed so stored lists compare equal.
export function evidenceGaps(input: ModelInput): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  if (!input.behaviour_trail.available) gaps.push("behaviour_trail");
  if (!input.checkout.available) gaps.push("checkout_log");
  if (!input.card.available) gaps.push("card_details");
  return gaps;
}

// What the merchant is shown, for an INSUFFICIENT_EVIDENCE diagnosis.
const NEEDED: Record<EvidenceGap, string> = {
  behaviour_trail: "What the buyer did on your site before paying (the behaviour trail isn't connected yet).",
  checkout_log: "The buyer's steps inside the Paystack checkout (Paystack returned no checkout log for this payment).",
  card_details: "The card or account the buyer tried to pay with (Paystack returned no card details for this payment).",
};

export function describeEvidenceNeeded(gaps: readonly EvidenceGap[]): { summary: string; needed: string[] } {
  return {
    summary: "Could not determine why this payment stalled.",
    needed: gaps.length ? gaps.map((g) => NEEDED[g]) : ["More detail about this payment than is currently available."],
  };
}

// What a merchant is shown for one diagnosis.
//
// On INSUFFICIENT_EVIDENCE there is deliberately no confidence figure. There,
// confidence means "how sure the model is that the evidence is insufficient",
// not confidence in a reason; "could not determine, 85% confident" means
// nothing to a seller and reads as the opposite of what it is.
export type MerchantView =
  | { kind: "undetermined"; summary: string; needed: string[] }
  | { kind: "diagnosed"; reason: Reason; confidence: number };

export function merchantView(d: { reason: Outcome; confidence: number; evidenceGaps: readonly EvidenceGap[] }): MerchantView {
  if (d.reason === INSUFFICIENT_EVIDENCE) return { kind: "undetermined", ...describeEvidenceNeeded(d.evidenceGaps) };
  return { kind: "diagnosed", reason: d.reason, confidence: d.confidence };
}
