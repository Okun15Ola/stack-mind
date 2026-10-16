// The six stall reasons, exactly as diagnoses_reason_check has them.
export const REASONS = [
  "NO_FUNDS_NOW",
  "CARD_FAILING",
  "PROVIDER_DOWN",
  "NO_TRUST",
  "UNANSWERED_QUESTION",
  "FORGOT",
] as const;

export type Reason = (typeof REASONS)[number];

export function isReason(value: unknown): value is Reason {
  return typeof value === "string" && (REASONS as readonly string[]).includes(value);
}

export type Classification = {
  reason: Reason;
  confidence: number;
  rationale: string;
};
