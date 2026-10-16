import type { Classification, Reason } from "@/lib/reasons";

export const RULES_MODEL_ID = "rules:gateway-response@1";

type Rule = { reason: Reason; confidence: number; label: string; pattern: RegExp };

// Deterministic classification of Paystack gateway_response text. Only
// unambiguous strings are listed; anything else goes to the model. Order
// matters: the first match wins, so "Declined - insufficient funds" is a funds
// problem and not a card problem.
//
// Status and abandoned_by are deliberately not inputs. Paystack stores some
// declined cards as `abandoned`, so status would misread them as FORGOT.
const RULES: Rule[] = [
  {
    reason: "NO_FUNDS_NOW",
    confidence: 0.95,
    label: "insufficient funds",
    pattern: /insufficient funds|not sufficient funds|\bnsf\b|low balance/,
  },
  {
    reason: "NO_FUNDS_NOW",
    confidence: 0.85,
    label: "spending limit",
    pattern: /exceeds? (?:the )?(?:\w+ )?(?:withdrawal |amount |transaction |daily )?limit|limit exceeded/,
  },
  {
    reason: "PROVIDER_DOWN",
    confidence: 0.9,
    label: "issuer or system outage",
    pattern:
      /issuer (?:or switch )?(?:is )?(?:inoperative|unavailable|not available)|switch inoperative|system malfunction|service unavailable|bank (?:is )?(?:unavailable|not available|down)/,
  },
  {
    reason: "CARD_FAILING",
    confidence: 0.95,
    label: "specific card problem",
    pattern:
      /do not hono(?:u)?r|expired card|card (?:has )?expired|invalid card|restricted card|lost card|stolen card|pick ?up card|card (?:is )?blocked|incorrect pin|invalid pin|pin tries exceeded|not permitted to cardholder|card not enabled|suspected fraud|security violation|invalid (?:cvv|cvc|expiry)/,
  },
  {
    reason: "CARD_FAILING",
    confidence: 0.85,
    label: "decline",
    pattern: /declin/,
  },
];

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// Returns a classification for a recognised gateway_response, or null when the
// text is missing or not unambiguous enough to call without a model.
export function classifyGatewayResponse(gatewayResponse: string | null | undefined): Classification | null {
  if (!gatewayResponse) return null;
  const text = normalise(gatewayResponse);

  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return {
        reason: rule.reason,
        confidence: rule.confidence,
        rationale: `Paystack gateway_response "${gatewayResponse.trim()}" matches the ${rule.label} rule.`,
      };
    }
  }
  return null;
}
