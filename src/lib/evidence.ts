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
