// The six stall reasons. Each one is a cause a remedy can address.
export const REASONS = [
  "NO_FUNDS_NOW",
  "CARD_FAILING",
  "PROVIDER_DOWN",
  "NO_TRUST",
  "UNANSWERED_QUESTION",
  "FORGOT",
] as const;

export type Reason = (typeof REASONS)[number];

// Not a reason: the facts we have can't separate the candidate reasons. It is
// returned instead of a guess, maps to no action in the Mandate, and is shown
// to the merchant as "could not determine" with the evidence that would be
// needed (built by code from the input's gaps, see src/lib/evidence.ts).
// Only the model can return it; the gateway rules never do.
export const INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE" as const;

// Every diagnosis outcome, exactly as diagnoses_reason_check has them.
export const OUTCOMES = [...REASONS, INSUFFICIENT_EVIDENCE] as const;

export type Outcome = (typeof OUTCOMES)[number];

export function isReason(value: unknown): value is Reason {
  return typeof value === "string" && (REASONS as readonly string[]).includes(value);
}

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

export type Classification = {
  reason: Outcome;
  confidence: number;
  rationale: string;
};

// What the gateway rules produce: always a real reason, never
// INSUFFICIENT_EVIDENCE.
export type RuleClassification = Classification & { reason: Reason };
