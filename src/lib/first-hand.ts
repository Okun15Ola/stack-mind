import type { StoredEvent } from "@/lib/behaviour/trail";
import type { Outcome } from "@/lib/reasons";

// FIRST-HAND evidence, per reason (issue #12, decisions of 3 November 2026).
//
// The Mandate's Ask-once gate: an Ask-once action (anything that costs money,
// crosses to a new channel, or falls outside quiet hours) requires at least
// one piece of first-hand evidence FOR THE REASON being acted on. Standing
// actions may run on browser evidence.
//
// First-hand means a Paystack transaction field Opada fetched itself over the
// API, or a server_observed behaviour event. Browser-originated evidence
// never qualifies alone: server_relayed and client events, and Paystack's
// provider-relayed checkout log, are not in this table and never may be
// (tests/guards.ts fails if they are).
//
// "For the reason" is not "present in the trail": a server_observed
// payment_started says nothing about trust, so it doesn't count for NO_TRUST.
// This table is read by code. It is never a runtime judgement and never read
// from the model's rationale.

export const FIRST_HAND_TYPES = [
  // Paystack's own description of the outcome, fetched by Opada, counted
  // ONLY when the deterministic gateway rules (src/lib/gateway-rules.ts)
  // matched the same reason. Text the rules don't recognise ("The transaction
  // was not completed") says nothing about a card, so counting it for a
  // model-assigned CARD_FAILING would make the gate rubber-stamp the model's
  // guess. First-hand evidence must corroborate the reason independently.
  // This makes the rules classifier a safety component: never remove it as
  // redundant with the model.
  "paystack:gateway_response",
  // The merchant's server received the buyer's question (a form submission).
  "server_observed:question_asked",
] as const;
export type FirstHandType = (typeof FIRST_HAND_TYPES)[number];

// Paystack's status, amount and timestamps are first-hand too, but none of
// them bears on WHY a payment stalled, so no reason lists them. A
// server_observed payment_started or checkout_started is first-hand that the
// checkout happened, not evidence for any reason, so likewise.
export const FIRST_HAND_FOR_REASON: Record<Outcome, readonly FirstHandType[]> = {
  CARD_FAILING: ["paystack:gateway_response"],
  NO_FUNDS_NOW: ["paystack:gateway_response"],
  PROVIDER_DOWN: ["paystack:gateway_response"],
  UNANSWERED_QUESTION: ["server_observed:question_asked"],
  // Trust is a browser-side state: nothing a server or Paystack observes
  // bears on it today. Standing actions only.
  NO_TRUST: [],
  // "Never really attempted" has no first-hand observation today: the
  // absence of further events is not an observation.
  FORGOT: [],
  // Maps to no action at all.
  INSUFFICIENT_EVIDENCE: [],
};

export type EvidenceFacts = {
  // The reason the deterministic gateway rules matched on Paystack's
  // gateway_response, or null if they matched nothing. Never the model's.
  gatewayRulesReason: Outcome | null;
  trailEvents: readonly Pick<StoredEvent, "type" | "source" | "properties">[];
};

function present(type: FirstHandType, reason: Outcome, facts: EvidenceFacts): boolean {
  switch (type) {
    case "paystack:gateway_response":
      return facts.gatewayRulesReason === reason;
    case "server_observed:question_asked":
      return facts.trailEvents.some((e) => e.type === "question_asked" && e.source === "server_observed");
  }
}

// The first-hand evidence present FOR this reason, in table order.
export function firstHandEvidence(reason: Outcome, facts: EvidenceFacts): FirstHandType[] {
  return FIRST_HAND_FOR_REASON[reason].filter((t) => present(t, reason, facts));
}

// The Ask-once gate, for the Mandate. Standing actions don't consult it.
export function askOnceAllowed(d: { reason: Outcome; first_hand_evidence: readonly string[] }): boolean {
  if (d.reason === "INSUFFICIENT_EVIDENCE") return false;
  const allowed = FIRST_HAND_FOR_REASON[d.reason] as readonly string[];
  return d.first_hand_evidence.some((e) => allowed.includes(e));
}
